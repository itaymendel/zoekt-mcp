import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createMcpServer, type ServerDeps } from "../../src/server.js";

export interface TestMcp {
	client: Client;
	/** Closes the client (and with it the linked in-memory transport). */
	close(): Promise<void>;
}

/** A v2 MCP `Client` named "test-client" (not yet connected). */
export function makeTestClient(options?: ConstructorParameters<typeof Client>[1]): Client {
	return new Client({ name: "test-client", version: "0.0.0" }, options);
}

/** An in-memory v2 MCP `Client` connected to a fresh `createMcpServer(deps)`. */
export async function connectTestClient(deps: ServerDeps): Promise<TestMcp> {
	const server = createMcpServer(deps);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = makeTestClient();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return { client, close: () => client.close() };
}

/** The text of the first content block of a tool result. */
export function resultText(result: { content?: unknown }): string {
	const first = (result.content as Array<{ type: string; text?: string }>)[0];
	return first?.text ?? "";
}
