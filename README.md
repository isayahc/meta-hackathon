# DexScreener MCP Server

An MCP server implementation for accessing the DexScreener API, providing real-time access to DEX pair data, token information, and market statistics across multiple blockchains.

One-line install (automatically adds to Claude Desktop):
```bash
curl -L https://raw.githubusercontent.com/isayahc/meta-hackathon/main/install.sh | bash
```

## Meta Global AI Developer Hackathon — Scope

Built for the [Meta Global AI Developer Hackathon 2026](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (Meta + Cerebral Valley, Oct 26 – Nov 4, 2026; submissions due Nov 4, 9:00 PM ET). Indie track: judged on creativity, technical ambition, and whether it works.

Meta technologies available for this build:

### Meta Model API

All four models are served through the Meta Model API (`api.meta.ai/v1`), which is OpenAI-SDK compatible.

- **Muse Spark series** — Meta's closed-weights reasoning models from Superintelligence Labs, built for agentic work: tool use, computer use, coding, and multimodal understanding, including visual chain-of-thought and multi-agent orchestration. The current generation offers a 1M-token context window. Example uses: coding agents (Spark powers Muse Code), long multi-step tool workflows, agents that operate apps and browsers.
- **Muse Wonder (and Wonder Full)** — Meta's frontier agent models for complex personal and professional tasks, with 1M-token context ($4 / $20 per 1M input/output tokens via the API). Example uses: interpreting leases and contracts, navigating insurance claims, reviewing financial documents and medical information, long-running coding tasks, domain work in law, finance, and health.
- **Muse Image** — Meta's image generation and editing model, live in Meta AI, Instagram, and WhatsApp. It reasons over prompts before rendering, and handles edits, multi-photo blends, object removal, and legible text inside visuals. Example uses: posters and marketing visuals, infographics, custom QR codes, room redesigns, stickers, photo cleanup.
- **SAM 3.1** — promptable visual segmentation foundation model: describe an object in words (or point at an example/box) and it detects, masks, and tracks every match across images and video, zero-shot. v3.1 adds object multiplexing (up to 16 objects in one pass) and roughly 2x faster video tracking. Example uses: real-time multi-object video tracking, creative masking and editing, robotics perception, open-vocabulary visual search, inspection workflows.
- **Meta open-weights models** — via partner credits to select participants: Baseten ($100 + 2M TPM rate limits), Modal ($100, plus serverless GPUs, sandboxes, and LLM training tools), Fireworks ($25 + workshop from Sinan Ozdemir)
- **Muse Code** — Meta's agentic coding agent, used to build this project
- **Workshops + Discord office hours** — live support from Meta and partners during the build window

## Features

- Rate-limited API access (respects DexScreener's rate limits)
- Comprehensive error handling
- Type-safe interfaces
- Support for all DexScreener API endpoints
- Integration tests

## Installation

Manual installation:
```bash
npm install
npm run build
npm run setup
```

## Testing

```bash
npm test
```

## Usage

### Available Tools

1. `get_latest_token_profiles`
   - Get the latest token profiles
   - No parameters required
   ```typescript
   const result = await mcpClient.callTool('dexscreener', 'get_latest_token_profiles');
   ```

2. `get_latest_boosted_tokens`
   - Get the latest boosted tokens
   - No parameters required
   ```typescript
   const result = await mcpClient.callTool('dexscreener', 'get_latest_boosted_tokens');
   ```

3. `get_top_boosted_tokens`
   - Get tokens with most active boosts
   - No parameters required
   ```typescript
   const result = await mcpClient.callTool('dexscreener', 'get_top_boosted_tokens');
   ```

4. `get_token_orders`
   - Check orders paid for a specific token
   ```typescript
   const result = await mcpClient.callTool('dexscreener', 'get_token_orders', {
     chainId: 'solana',
     tokenAddress: 'So11111111111111111111111111111111111111112'
   });
   ```

5. `get_pairs_by_chain_and_address`
   - Get one or multiple pairs by chain and pair address
   ```typescript
   const result = await mcpClient.callTool('dexscreener', 'get_pairs_by_chain_and_address', {
     chainId: 'solana',
     pairId: 'HxFLKUAmAMLz1jtT3hbvCMELwH5H9tpM2QugP8sKyfhc'
   });
   ```

6. `get_pairs_by_token_addresses`
   - Get one or multiple pairs by token address (max 30)
   ```typescript
   const result = await mcpClient.callTool('dexscreener', 'get_pairs_by_token_addresses', {
     tokenAddresses: 'So11111111111111111111111111111111111111112'
   });
   ```

7. `search_pairs`
   - Search for pairs matching query
   ```typescript
   const result = await mcpClient.callTool('dexscreener', 'search_pairs', {
     query: 'SOL'
   });
   ```

## Rate Limits

The server implements rate limiting to comply with DexScreener's API limits:
- Token Profile/Boost endpoints: 60 requests per minute
- DEX/Pairs endpoints: 300 requests per minute

## Error Handling

The server handles various error scenarios:
- Rate limit exceeded
- Invalid parameters
- Network errors
- API errors

Errors are returned in a standardized format with appropriate error codes and messages.

## API Documentation

For detailed API documentation, see [docs/api-reference.md](docs/api-reference.md).

## Development

### Project Structure

```
.
├── src/
│   ├── types/           # TypeScript interfaces and types
│   ├── services/        # API service implementations
│   ├── tests/           # Integration tests
│   └── index.ts         # Main server implementation
├── scripts/            # Setup and utility scripts
├── docs/              # Documentation
└── README.md          # This file
```

### Adding New Features

1. Define types in `src/types/`
2. Implement service methods in `src/services/`
3. Add tool handlers in `src/index.ts`
4. Update documentation
5. Add tests

## License

MIT
