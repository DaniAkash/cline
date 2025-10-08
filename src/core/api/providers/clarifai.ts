import { Anthropic } from "@anthropic-ai/sdk"
import { type ClarifaiModelId, clarifaiDefaultModelId, clarifaiModels, type ModelInfo } from "@shared/api"
import OpenAI from "openai"
import { ApiHandler, CommonApiHandlerOptions } from "../index"
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { convertToR1Format } from "../transform/r1-format"
import { ApiStream } from "../transform/stream"

interface ClarifaiHandlerOptions extends CommonApiHandlerOptions {
	clarifaiApiKey?: string
	apiModelId?: string
}

export class ClarifaiHandler implements ApiHandler {
	private client: OpenAI | undefined

	constructor(private readonly options: ClarifaiHandlerOptions) {}

	private ensureClient(): OpenAI {
		if (!this.client) {
			if (!this.options.clarifaiApiKey) {
				throw new Error("CLARIFAI Personal Access Token is required")
			}
			try {
				this.client = new OpenAI({
					baseURL: "https://api.clarifai.com/v2/ext/openai/v1",
					apiKey: this.options.clarifaiApiKey,
				})
			} catch (error) {
				throw new Error(`Error creating Clarifai client: ${error.message}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		const client = this.ensureClient()
		const model = this.getModel()

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = model.id.includes("DeepSeek-R1")
			? convertToR1Format([{ role: "user", content: systemPrompt }, ...messages])
			: [{ role: "system", content: systemPrompt }, ...convertToOpenAiMessages(messages)]

		const stream = await client.chat.completions.create({
			model: model.id,
			messages: openAiMessages,
			temperature: 0,
			stream: true,
			stream_options: { include_usage: true },
		})
		for await (const chunk of stream) {
			const delta = chunk.choices[0]?.delta
			if (delta?.content) {
				yield {
					type: "text",
					text: delta.content,
				}
			}

			if (delta && "reasoning_content" in delta && delta.reasoning_content) {
				yield {
					type: "reasoning",
					reasoning: (delta.reasoning_content as string | undefined) || "",
				}
			}

			if (chunk.usage) {
				yield {
					type: "usage",
					inputTokens: chunk.usage.prompt_tokens || 0,
					outputTokens: chunk.usage.completion_tokens || 0,
				}
			}
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		const modelId = this.options.apiModelId

		if (modelId !== undefined && modelId in clarifaiModels) {
			return { id: modelId, info: clarifaiModels[modelId as ClarifaiModelId] }
		}
		return { id: clarifaiDefaultModelId, info: clarifaiModels[clarifaiDefaultModelId] }
	}
}
