// Fake MCP server that pollutes stdout with a non-JSON-RPC line. Used to test smoke-stdio.mjs.
console.log("hello, this is not json-rpc");
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
