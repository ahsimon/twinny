import AsyncLock from "async-lock"
import fs from "fs"
import ignore from "ignore"
import path from "path"
import {
  ExtensionContext,
  InlineCompletionContext,
  InlineCompletionItem,
  InlineCompletionItemProvider,
  InlineCompletionList,
  InlineCompletionTriggerKind,
  Position,
  Range,
  StatusBarItem,
  TextDocument,
  Uri,
  window,
  workspace
} from "vscode"
import Parser, { SyntaxNode } from "web-tree-sitter"

import "string_score"

import {
  FIM_TEMPLATE_FORMAT,
  LINE_BREAK_REGEX,
  MAX_CONTEXT_LINE_COUNT,
  MAX_EMPTY_COMPLETION_CHARS,
  MIN_COMPLETION_CHUNKS,
  MULTI_LINE_DELIMITERS,
  MULTILINE_INSIDE,
  MULTILINE_OUTSIDE
} from "../../common/constants"
import { supportedLanguages } from "../../common/languages"
import { logger } from "../../common/logger"
import {
  FimTemplateData,
  PrefixSuffix,
  RepositoryLevelData as RepositoryDocment,
  ResolvedInlineCompletion,
  StreamRequestOptions,
  StreamResponse
} from "../../common/types"
import { getLineBreakCount } from "../../webview/utils"
import { Base } from "../base"
import { cache } from "../cache"
import { CompletionFormatter } from "../completion-formatter"
import { FileInteractionCache } from "../file-interaction"
import {
  getFimPrompt,
  getFimTemplateRepositoryLevel,
  getStopWords
} from "../fim-templates"
import { llm } from "../llm"
import { getNodeAtPosition, getParser } from "../parser"
import { TwinnyProvider } from "../provider-manager"
import { createStreamRequestBodyFim } from "../provider-options"
import { TemplateProvider } from "../template-provider"
import {
  getCurrentLineText,
  getFimDataFromProvider,
  getIsMiddleOfString,
  getIsMultilineCompletion,
  getPrefixSuffix,
  getShouldSkipCompletion
} from "../utils"

export class CompletionProvider
  extends Base
  implements InlineCompletionItemProvider
{
  private _abortController: AbortController | null
  private _acceptedLastCompletion = false
  private _chunkCount = 0
  private _completion = ""
  private _debouncer: NodeJS.Timeout | undefined
  private _document: TextDocument | null
  private _fileInteractionCache: FileInteractionCache
  private _isMultilineCompletion = false
  private _lastCompletionMultiline = false
  private _lock: AsyncLock
  private _nodeAtPosition: SyntaxNode | null = null
  private _nonce = 0
  private _parser: Parser | undefined
  private _position: Position | null
  private _prefixSuffix: PrefixSuffix = { prefix: "", suffix: "" }
  private _provider: TwinnyProvider | undefined
  private _statusBar: StatusBarItem
  private _templateProvider: TemplateProvider
  private _usingFimTemplate = false
  public lastCompletionText = ""

  constructor(
    statusBar: StatusBarItem,
    fileInteractionCache: FileInteractionCache,
    templateProvider: TemplateProvider,
    context: ExtensionContext
  ) {
    super(context)
    this._abortController = null
    this._document = null
    this._lock = new AsyncLock()
    this._position = null
    this._statusBar = statusBar
    this._fileInteractionCache = fileInteractionCache
    this._templateProvider = templateProvider
  }

  private buildFimRequest(prompt: string, provider: TwinnyProvider) {
    const body = createStreamRequestBodyFim(provider.provider, prompt, {
      model: provider.modelName,
      numPredictFim: this.config.numPredictFim,
      temperature: this.config.temperature,
      keepAlive: this.config.keepAlive
    })

    const options: StreamRequestOptions = {
      hostname: provider.apiHostname || "",
      port: provider.apiPort ? Number(provider.apiPort) : undefined,
      path: provider.apiPath || "",
      protocol: provider.apiProtocol || "",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: provider.apiKey ? `Bearer ${provider.apiKey}` : ""
      }
    }

    return { options, body }
  }

  public async provideInlineCompletionItems(
    document: TextDocument,
    position: Position,
    context: InlineCompletionContext
  ): Promise<InlineCompletionItem[] | InlineCompletionList | null | undefined> {
    const editor = window.activeTextEditor
    this._provider = this.getFimProvider()
    const isLastCompletionAccepted =
      this._acceptedLastCompletion && !this.config.enableSubsequentCompletions

    this._prefixSuffix = getPrefixSuffix(
      this.config.contextLength,
      document,
      position
    )

    const languageEnabled =
      this.config.enabledLanguages[document.languageId] ??
      this.config.enabledLanguages["*"] ??
      true

    if (!languageEnabled) return

    const cachedCompletion = cache.getCache(this._prefixSuffix)
    if (cachedCompletion && this.config.completionCacheEnabled) {
      this._completion = cachedCompletion
      return this.provideInlineCompletion()
    }

    if (
      context.triggerKind === InlineCompletionTriggerKind.Invoke &&
      this.config.autoSuggestEnabled
    ) {
      this._completion = this.lastCompletionText
      return this.provideInlineCompletion()
    }

    if (
      !this.config.enabled ||
      !editor ||
      isLastCompletionAccepted ||
      this._lastCompletionMultiline ||
      getShouldSkipCompletion(context, this.config.autoSuggestEnabled) ||
      getIsMiddleOfString()
    ) {
      this._statusBar.text = "$(code)"
      return
    }

    this._chunkCount = 0
    this._document = document
    this._position = position
    this._nonce = this._nonce + 1
    this._statusBar.text = "$(loading~spin)"
    this._statusBar.command = "twinny.stopGeneration"
    await this.tryParseDocument(document)

    this._isMultilineCompletion = getIsMultilineCompletion({
      node: this._nodeAtPosition,
      prefixSuffix: this._prefixSuffix
    })

    if (this._debouncer) clearTimeout(this._debouncer)

    const prompt = await this.getPrompt(this._prefixSuffix)

    if (!prompt) return

    return new Promise<ResolvedInlineCompletion>((resolve, reject) => {
      this._debouncer = setTimeout(() => {
        this._lock.acquire("twinny.completion", async () => {
          const provider = this.getFimProvider()
          if (!provider) return
          const request = this.buildFimRequest(prompt, provider)

          if (!request) return

          try {
            await llm({
              body: request.body,
              options: request.options,
              onStart: (controller) => (this._abortController = controller),
              onEnd: () => this.onEnd(resolve),
              onError: this.onError,
              onData: (data) => {
                const completion = this.onData(data as StreamResponse)
                if (completion) {
                  this._abortController?.abort()
                }
              }
            })
          } catch {
            this.onError()
            reject([])
          }
        })
      }, this.config.debounceWait)
    })
  }

  private async tryParseDocument(document: TextDocument) {
    try {
      if (!this._position || !this._document) return
      const parser = await getParser(document.uri.fsPath)

      if (!parser || !parser.parse) return

      this._parser = parser

      this._nodeAtPosition = getNodeAtPosition(
        this._parser?.parse(this._document.getText()),
        this._position
      )
    } catch {
      return
    }
  }

  private onData(data: StreamResponse | undefined): string {
    if (!this._provider) return ""

    const stopWords = getStopWords(
      this._provider.modelName,
      this._provider.fimTemplate || FIM_TEMPLATE_FORMAT.automatic
    )

    try {
      const providerFimData = getFimDataFromProvider(
        this._provider.provider,
        data
      )
      if (providerFimData === undefined) return ""

      this._completion = this._completion + providerFimData
      this._chunkCount = this._chunkCount + 1

      if (
        this._completion.length > MAX_EMPTY_COMPLETION_CHARS &&
        this._completion.trim().length === 0
      ) {
        this.abortCompletion()
        logger.log(
          `Streaming response end as llm in empty completion loop:  ${this._nonce}`
        )
      }

      if (stopWords.some((stopWord) => this._completion.includes(stopWord))) {
        return this._completion
      }

      if (
        !this.config.multilineCompletionsEnabled &&
        this._chunkCount >= MIN_COMPLETION_CHUNKS &&
        LINE_BREAK_REGEX.test(this._completion.trimStart())
      ) {
        logger.log(
          `Streaming response end due to single line completion:  ${this._nonce} \nCompletion: ${this._completion}`
        )
        return this._completion
      }

      const shouldSwitchToMultiline =
        !this._isMultilineCompletion &&
        this.config.multilineCompletionsEnabled &&
        this._chunkCount >= MIN_COMPLETION_CHUNKS &&
        LINE_BREAK_REGEX.test(this._completion.trimStart())

      if (shouldSwitchToMultiline) {
        this._isMultilineCompletion = true
        logger.log(
          `Switching to multiline mode at ${this._nonce} \nCompletion so far: ${this._completion}`
        )
      }

      try {
        if (!this._nodeAtPosition || !this._parser) return ""

        const lineText = getCurrentLineText(this._position) || ""

        const nodeType = this._nodeAtPosition.type
        const parentType = this._nodeAtPosition.parent?.type
        const isTopLevelNode = MULTILINE_OUTSIDE.includes(nodeType)
        const isNestedNode = MULTILINE_INSIDE.includes(nodeType)
        const hasComplexStructure = this._nodeAtPosition.childCount > 2

        const isInCodeBlock = isTopLevelNode ||
          (isNestedNode && (hasComplexStructure || parentType === "program"))

        if (providerFimData.includes("\n")) {
          const tree = this._parser.parse(`${lineText}${this._completion}`)
          const rootNode = tree.rootNode

          const isComplete = this.isCompleteSyntaxTree(rootNode)

          const hasBalancedDelimiters = this.hasBalancedDelimiters(this._completion)

          if (
            this._isMultilineCompletion &&
            this._chunkCount >= 2 &&
            isInCodeBlock &&
            !rootNode.hasError
          ) {
            if (
              isComplete ||
              hasBalancedDelimiters ||
              MULTI_LINE_DELIMITERS.some(d => this._completion.endsWith(d))
            ) {
              logger.log(
                `Streaming response end due to complete syntax at ${this._nonce}\nCompletion: ${this._completion}`
              )
              return this._completion
            }
          }
        }
      } catch (e) {
        logger.log(`Parser error at ${this._nonce}: ${e}`)
        if (this._chunkCount > 5) {
          this.abortCompletion()
        }
      }

      if (getLineBreakCount(this._completion) >= this.config.maxLines) {
        logger.log(
          `
            Streaming response end due to max line count ${this._nonce} \nCompletion: ${this._completion}
          `
        )
        return this._completion
      }

      return ""
    } catch (e) {
      console.error(e)
      return ""
    }
  }

  private onEnd(resolve: (completion: ResolvedInlineCompletion) => void) {
    return resolve(this.provideInlineCompletion())
  }

  public onError = () => {
    this._abortController?.abort()
  }

  private getPromptHeader(languageId: string | undefined, uri: Uri) {
    const lang =
      supportedLanguages[languageId as keyof typeof supportedLanguages]

    if (!lang) {
      return ""
    }

    const language = `${lang.syntaxComments?.start || ""} Language: ${
      lang?.langName
    } (${languageId}) ${lang.syntaxComments?.end || ""}`

    const path = `${
      lang.syntaxComments?.start || ""
    } File uri: ${uri.toString()} (${languageId}) ${
      lang.syntaxComments?.end || ""
    }`

    return `\n${language}\n${path}\n`
  }

  private async getRelevantDocuments(): Promise<RepositoryDocment[]> {
    const interactions = this._fileInteractionCache.getAll()
    const currentFileName = this._document?.fileName || ""
    const openTextDocuments = workspace.textDocuments
    const rootPath = workspace.workspaceFolders?.[0]?.uri.fsPath || ""
    const ig = ignore({ allowRelativePaths: true })

    const embeddingIgnoredGlobs = this.config.get(
      "embeddingIgnoredGlobs",
      [] as string[]
    )

    ig.add(embeddingIgnoredGlobs)

    const gitIgnoreFilePath = path.join(rootPath, ".gitignore")

    if (fs.existsSync(gitIgnoreFilePath)) {
      ig.add(fs.readFileSync(gitIgnoreFilePath).toString())
    }

    const openDocumentsData: RepositoryDocment[] = openTextDocuments
      .filter((doc) => {
        const isCurrentFile = doc.fileName === currentFileName
        const isGitFile =
          doc.fileName.includes(".git") || doc.fileName.includes("git/")

        const projectRoot = workspace.workspaceFolders?.[0].uri.fsPath || ""
        const relativePath = path.relative(projectRoot, doc.fileName)

        if (isGitFile) return false

        const normalizedPath = relativePath.split(path.sep).join("/")
        const isIgnored = ig.ignores(normalizedPath)

        return !isCurrentFile && !isIgnored
      })
      .map((doc) => {
        const interaction = interactions.find((i) => i.name === doc.fileName)
        return {
          uri: doc.uri,
          text: doc.getText(),
          name: doc.fileName,
          isOpen: true,
          relevanceScore: interaction?.relevanceScore || 0
        }
      })

    const otherDocumentsData: RepositoryDocment[] = (
      await Promise.all(
        interactions
          .filter(
            (interaction) =>
              !openTextDocuments.some(
                (doc) => doc.fileName === interaction.name
              )
          )
          .filter((interaction) => !ig.ignores(interaction.name || ""))
          .map(async (interaction) => {
            const filePath = interaction.name
            if (!filePath) return null
            if (
              filePath.toString().match(".git") ||
              currentFileName === filePath
            )
              return null
            const uri = Uri.file(filePath)
            try {
              const document = await workspace.openTextDocument(uri)
              return {
                uri,
                text: document.getText(),
                name: filePath,
                isOpen: false,
                relevanceScore: interaction.relevanceScore
              }
            } catch (error) {
              console.error(`Error opening document ${filePath}:`, error)
              return null
            }
          })
      )
    ).filter((doc): doc is RepositoryDocment => doc !== null)

    const allDocuments = [...openDocumentsData, ...otherDocumentsData].sort(
      (a, b) => b.relevanceScore - a.relevanceScore
    )

    return allDocuments.slice(0, 3)
  }

  private async getFileInteractionContext() {
    this._fileInteractionCache.addOpenFilesWithPriority()
    const interactions = this._fileInteractionCache.getAll()
    const currentFileName = this._document?.fileName || ""

    const fileChunks: string[] = []
    for (const interaction of interactions) {
      const filePath = interaction.name

      if (!filePath) return

      if (filePath.toString().match(".git")) continue

      const uri = Uri.file(filePath)

      if (currentFileName === filePath) continue

      const activeLines = interaction.activeLines

      const document = await workspace.openTextDocument(uri)
      const lineCount = document.lineCount

      if (lineCount > MAX_CONTEXT_LINE_COUNT) {
        const averageLine =
          activeLines.reduce((acc, curr) => acc + curr.line, 0) /
          activeLines.length
        const start = new Position(
          Math.max(0, Math.ceil(averageLine || 0) - 100),
          0
        )
        const end = new Position(
          Math.min(lineCount, Math.ceil(averageLine || 0) + 100),
          0
        )
        fileChunks.push(
          `
          // File: ${filePath}
          // Content: \n ${document.getText(new Range(start, end))}
        `.trim()
        )
      } else {
        fileChunks.push(
          `
          // File: ${filePath}
          // Content: \n ${document.getText()}
        `.trim()
        )
      }
    }

    return fileChunks.join("\n")
  }

  private removeStopWords(completion: string) {
    if (!this._provider) return completion
    let filteredCompletion = completion
    const stopWords = getStopWords(
      this._provider.modelName,
      this._provider.fimTemplate || FIM_TEMPLATE_FORMAT.automatic
    )
    stopWords.forEach((stopWord) => {
      filteredCompletion = filteredCompletion.split(stopWord).join("")
    })
    return filteredCompletion
  }

  private async getPrompt(prefixSuffix: PrefixSuffix) {
    if (!this._provider) return ""
    if (!this._document || !this._position || !this._provider) return ""

    const documentLanguage = this._document.languageId
    const fileInteractionContext = await this.getFileInteractionContext()

    if (this._provider.fimTemplate === FIM_TEMPLATE_FORMAT.custom) {
      const systemMessage =
        await this._templateProvider.readSystemMessageTemplate("fim-system.hbs")

      const fimTemplate =
        await this._templateProvider.readTemplate<FimTemplateData>("fim", {
          prefix: prefixSuffix.prefix,
          suffix: prefixSuffix.suffix,
          systemMessage,
          context: fileInteractionContext || "",
          fileName: this._document.uri.fsPath,
          language: documentLanguage
        })

      if (fimTemplate) {
        this._usingFimTemplate = true
        return fimTemplate
      }
    }

    if (this._provider.repositoryLevel) {
      const repositoryLevelData = await this.getRelevantDocuments()
      const repoName = workspace.name
      const currentFile = await this._document.uri.fsPath
      return getFimTemplateRepositoryLevel(
        repoName || "untitled",
        repositoryLevelData,
        prefixSuffix,
        currentFile
      )
    }

    return getFimPrompt(
      this._provider.modelName,
      this._provider.fimTemplate || FIM_TEMPLATE_FORMAT.automatic,
      {
        context: fileInteractionContext || "",
        prefixSuffix,
        header: this.getPromptHeader(documentLanguage, this._document.uri),
        fileContextEnabled: this.config.fileContextEnabled,
        language: documentLanguage
      }
    )
  }

  public setAcceptedLastCompletion(value: boolean) {
    this._acceptedLastCompletion = value
    this._lastCompletionMultiline = getLineBreakCount(this._completion) > 1
  }

  public abortCompletion() {
    this._abortController?.abort()
    this._statusBar.text = "$(code)"
  }

  private logCompletion(formattedCompletion: string) {
    logger.log(
      `
      *** Twinny completion triggered for file: ${this._document?.uri} ***
      Original completion: ${this._completion}
      Formatted completion: ${formattedCompletion}
      Max Lines: ${this.config.maxLines}
      Use file context: ${this.config.fileContextEnabled}
      Completed lines count ${getLineBreakCount(formattedCompletion)}
      Using custom FIM template fim.bhs?: ${this._usingFimTemplate}
    `.trim()
    )
  }

  private isCompleteSyntaxTree(node: SyntaxNode): boolean {
    if (!node) return false

    if (MULTILINE_OUTSIDE.includes(node.type)) {
      return !node.hasError && this.hasBalancedBraces(node.text)
    }

    if (MULTILINE_INSIDE.includes(node.type)) {
      return !node.hasError && node.childCount > 0
    }

    return node.children.every(child => this.isCompleteSyntaxTree(child))
  }

  private hasBalancedDelimiters(text: string): boolean {
    const stack: string[] = []
    const openDelims = ["{", "(", "[", "<"]
    const closeDelims = ["}", ")", "]", ">"]

    for (const char of text) {
      const openIndex = openDelims.indexOf(char)
      if (openIndex !== -1) {
        stack.push(char)
        continue
      }

      const closeIndex = closeDelims.indexOf(char)
      if (closeIndex !== -1) {
        if (stack.length === 0) return false
        const lastOpen = stack.pop()
        if (openDelims.indexOf(lastOpen!) !== closeIndex) return false
      }
    }

    return stack.length === 0
  }

  private hasBalancedBraces(text: string): boolean {
    let braceCount = 0

    for (const char of text) {
      if (char === "{") braceCount++
      if (char === "}") braceCount--
      if (braceCount < 0) return false
    }

    return braceCount === 0
  }

  private provideInlineCompletion(): InlineCompletionItem[] {
    const editor = window.activeTextEditor

    if (!editor || !this._position) return []

    const formattedCompletion = new CompletionFormatter(editor).format(
      this.removeStopWords(this._completion)
    )

    this.logCompletion(formattedCompletion)

    if (this.config.completionCacheEnabled)
      cache.setCache(this._prefixSuffix, formattedCompletion)

    this._completion = ""
    this._statusBar.text = "$(code)"
    this.lastCompletionText = formattedCompletion
    this._lastCompletionMultiline = getLineBreakCount(this._completion) > 1

    return [
      new InlineCompletionItem(
        formattedCompletion,
        new Range(this._position, this._position)
      )
    ]
  }
}
