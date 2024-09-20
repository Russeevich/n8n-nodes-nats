import { BinaryHelperFunctions, IDataObject, IExecuteFunctions, INodeExecutionData } from "n8n-workflow";
import { MsgHdrs, NatsConnection, Payload, RequestManyOptions, RequestOptions, headers } from "nats";

export async function publish(func: IExecuteFunctions, connection: NatsConnection, idx: number, returnData: INodeExecutionData[]): Promise<any> {
	const head = headers()
	for (const header of ((func.getNodeParameter('headersUi', idx) as IDataObject).headerValues ?? []) as IDataObject[]) {
		head.set(header.key as string, header.value as string)
	}
	let subject = func.getNodeParameter('subject', idx) as string
	const options = { headers: head }
	switch (func.getNodeParameter('contentType', idx)) {
		case 'string':
			connection.publish(subject, func.getNodeParameter('payload', idx) as string, options)
			break;
		case 'binaryData':
			const payloadBinaryPropertyName = func.getNodeParameter('payloadBinaryPropertyName', idx)
			connection.publish(subject, new Uint8Array(await func.helpers.getBinaryDataBuffer(idx, payloadBinaryPropertyName as string)), options)
			break;
	}
	returnData.push({
		json: { publish: true },
		pairedItem: idx
	})
}

export async function request(func: IExecuteFunctions, connection: NatsConnection, idx: number, returnData: INodeExecutionData[]): Promise<any> {
	const head = headers()
	for (const header of ((func.getNodeParameter('headersUi', idx) as IDataObject).headerValues ?? []) as IDataObject[]) {
		head.set(header.key as string, header.value as string)
	}
	const subject = func.getNodeParameter('subject', idx) as string

	const options = func.getNodeParameter('options', idx, {}) as IDataObject & NatsNodeMessageOptions & NatsNodeRequestOptions

	let payload:Payload

	switch (func.getNodeParameter('contentType', idx)) {
		case 'string':
			payload = func.getNodeParameter('payload', idx) as string
			break;
		case 'binaryData':
			const payloadBinaryPropertyName = func.getNodeParameter('payloadBinaryPropertyName', idx) as string
			const binary = await func.helpers.getBinaryDataBuffer(idx, payloadBinaryPropertyName)
			payload = new Uint8Array(binary)
			break;
		default:
			throw new Error("unknown content type")
	}

	if(options.requestMany) {
		const reqOpts:Partial<RequestManyOptions> = {
			headers: head,
			//todo implement strategy
			//strategy: RequestStrategy.Timer,
			maxMessages: options.replies,
			maxWait: options.timeout
		}

		const responses = await connection.requestMany(subject, payload, reqOpts)

		for await(const rsp of responses) {
			const	item = await createNatsNodeMessage(func.helpers, rsp, idx, options)

			returnData.push(item)
		}
	} else {
		const reqOpts:RequestOptions = {
			headers: head,
			timeout: options.timeout ?? 600
		}

		const rsp = await connection.request(subject, payload, reqOpts)

		const	item = await createNatsNodeMessage(func.helpers, rsp, idx, options)

		returnData.push(item)
	}
}

export type NatsNodeHeaders = Record<string,string|string[]>

export type NatsNodeData = IDataObject|string

export interface NatsNodeMessage {
	subject:string
	reply?:string
	headers:NatsNodeHeaders
	data?:NatsNodeData
}

export interface NatsNodeMessageOptions {
	jsonParseBody?:boolean
	contentIsBinary?:boolean
	onlyContent?:boolean
}

export interface NatsNodeRequestOptions {
	timeout?: number,
	requestMany?: boolean,
	replies?:number
}

export interface INatsMsgLike {
	subject: string
	reply?:string
	data: Uint8Array,
	headers?:MsgHdrs

	json<T>(): T
	string(): string
}

export async function createNatsNodeMessage(helpers: BinaryHelperFunctions, msg:INatsMsgLike, idx?: number, options:NatsNodeMessageOptions = {}) {

	const item: INodeExecutionData = {
		json: {},
		pairedItem: idx
	}

	let jsonParse = options.jsonParseBody

	if(jsonParse === undefined && msg.data.length >= 2) {
		jsonParse = msg.data.at(0) === 123 && msg.data.at(-1) === 125
	}

	if (options.contentIsBinary === true) {
		//todo get output binary name
		item.binary = {
			data: await helpers.prepareBinaryData(Buffer.from(msg.data)),
		}
	} else if(jsonParse) {
		const data = msg.data.length > 0
			? msg.json<IDataObject>() : {}

		if(options.onlyContent)
			item.json = data
		else
			item.json.data = data

	} else {
		item.json.data = msg.string()
	}

	if (!options.onlyContent) {
		//todo option for delivery info

		item.json.subject = msg.subject
		if(msg.reply)
			item.json.reply = msg.reply

		//copy header values
		const headers:NatsNodeHeaders = {}
		if(msg.headers) {
			for(var entry of msg.headers) {
				const values = entry[1]
				headers[entry[0]] = values.length == 1 ? values[0] : values
			}
		}

		item.json.headers = headers
	}

	return item
}
