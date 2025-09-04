#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import Redis from "ioredis";

interface Memory {
  id: string;
  content: string;
  userId: string;
  timestamp: Date;
}

class CombinedMemoryServer {
  private server: McpServer;
  private memories: Memory[] = [];
  private fastifyServer: any;
  private redis: Redis;

  constructor() {
    this.server = new McpServer({
      name: "CombinedMemory-v2-SSE",
      version: "2.0.0",
    });

    // Initialize Redis/DragonflyDB connection
    this.redis = new Redis({
      host: process.env.DRAGONFLY_HOST || 'dragonflydb.railway.internal',
      port: parseInt(process.env.DRAGONFLY_PORT || '6379'),
      // Connection retry settings for better reliability
      lazyConnect: false,
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
      connectTimeout: 10000,
      commandTimeout: 5000,
    });

    // Setup connection error handlers
    this.redis.on('connect', () => {
      console.log('✅ DragonflyDB connection established');
    });
    
    this.redis.on('error', (error) => {
      console.error('❌ DragonflyDB connection error:', error.message);
    });
    
    this.redis.on('close', () => {
      console.warn('⚠️  DragonflyDB connection closed');
    });

    this.setupToolHandlers();
    this.setupFastifyServer();
  }

  private setupToolHandlers() {
    // Register add-memory tool
    this.server.registerTool(
      "add-memory",
      {
        title: "Add Memory",
        description: "Add a new memory. This method is called everytime the user informs anything about themselves, their preferences, or anything that has any relevent information whcih can be useful in the future conversation. This can also be called when the user asks you to remember something.",
        inputSchema: {
          content: z.string(),
          userId: z.string().default("quinn_may"),
        }
      },
      async ({ content, userId }) => {
        return await this.addMemory({ content, userId });
      }
    );

    // Register search-memories tool  
    this.server.registerTool(
      "search-memories",
      {
        title: "Search Memories",
        description: "Search through stored memories. This method is called ANYTIME the user asks anything.",
        inputSchema: {
          query: z.string(),
          userId: z.string().default("quinn_may"),
        }
      },
      async ({ query, userId }) => {
        return await this.searchMemories({ query, userId });
      }
    );
  }

  private async addMemory(args: any) {
    const schema = z.object({
      content: z.string(),
      userId: z.string().default("quinn_may"),
    });

    const { content, userId } = schema.parse(args);
    
    const memory: Memory = {
      id: Math.random().toString(36).substring(2, 15),
      content,
      userId,
      timestamp: new Date(),
    };

    try {
      // Store in DragonflyDB
      const memoryKey = `memory:${userId}:${memory.id}`;
      const memoryData = JSON.stringify({
        id: memory.id,
        content: memory.content,
        userId: memory.userId,
        timestamp: memory.timestamp.toISOString(),
      });
      
      await this.redis.set(memoryKey, memoryData);
      
      // Also add to search index
      const userSearchKey = `search:${userId}`;
      await this.redis.sadd(userSearchKey, memory.id);
      
      console.log(`✅ Memory stored in DragonflyDB: ${memoryKey}`);
    } catch (error) {
      console.warn('DragonflyDB unavailable, using in-memory fallback:', error);
      // Fallback to in-memory storage
      this.memories.push(memory);
    }

    return [
      {
        type: "text",
        text: `Memory added successfully for user ${userId}: "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`,
      },
    ];
  }

  private async searchMemories(args: any) {
    const schema = z.object({
      query: z.string(),
      userId: z.string().default("quinn_may"),
    });

    const { query, userId } = schema.parse(args);
    const queryLower = query.toLowerCase();
    let matchingMemories: Memory[] = [];

    try {
      // Search in DragonflyDB
      const userSearchKey = `search:${userId}`;
      const memoryIds = await this.redis.smembers(userSearchKey);
      
      for (const memoryId of memoryIds) {
        const memoryKey = `memory:${userId}:${memoryId}`;
        const memoryData = await this.redis.get(memoryKey);
        
        if (memoryData) {
          const memory = JSON.parse(memoryData);
          memory.timestamp = new Date(memory.timestamp);
          
          // Simple relevance scoring based on keyword matches
          if (memory.content.toLowerCase().includes(queryLower)) {
            matchingMemories.push(memory);
          }
        }
      }
      
      console.log(`🔍 DragonflyDB search for "${query}": ${matchingMemories.length} results`);
    } catch (error) {
      console.warn('DragonflyDB search failed, using in-memory fallback:', error);
      // Fallback to in-memory search
      matchingMemories = this.memories
        .filter(memory => 
          memory.userId === userId &&
          memory.content.toLowerCase().includes(queryLower)
        );
    }

    // Sort by timestamp (most recent first)
    matchingMemories.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    // Format results
    if (matchingMemories.length === 0) {
      return [
        {
          type: "text",
          text: `No memories found for query: "${query}"`,
        },
      ];
    }

    const resultsText = matchingMemories
      .slice(0, 10) // Limit to top 10 results
      .map((memory, index) => 
        `${index + 1}. [${memory.timestamp.toISOString().split('T')[0]}] ${memory.content}`
      )
      .join('\n\n');

    return [
      {
        type: "text",
        text: `Found ${matchingMemories.length} matching memories for "${query}":\n\n${resultsText}`,
      },
    ];
  }

  private setupFastifyServer() {
    this.fastifyServer = fastify({ logger: false });
    
    // Register CORS plugin
    this.fastifyServer.register(cors, {
      origin: true,
      credentials: true,
    });

    // Bearer token authentication middleware
    this.fastifyServer.addHook('preValidation', async (request: any, reply: any) => {
      // Skip auth for health endpoint
      if (request.url === '/health') {
        return;
      }

      const authHeader = request.headers.authorization;
      const expectedToken = process.env.MCP_BEARER_TOKEN || 'sk-combinedmemory-v2-secure-token-2024';
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        reply.code(401).send({ error: 'Missing or invalid Authorization header' });
        return;
      }
      
      const token = authHeader.substring(7); // Remove 'Bearer ' prefix
      if (token !== expectedToken) {
        reply.code(401).send({ error: 'Invalid bearer token' });
        return;
      }
    });

    // Health check endpoint
    this.fastifyServer.get('/health', async () => {
      let dragonflyStatus = 'unavailable';
      try {
        await this.redis.ping();
        dragonflyStatus = 'connected';
      } catch (error) {
        console.error('DragonflyDB health check failed:', error);
      }

      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '2.0.0-SSE',
        dragonfly: dragonflyStatus,
        fallback: dragonflyStatus === 'unavailable' ? 'in-memory' : 'not needed'
      };
    });

    // MCP SSE transport endpoint
    this.fastifyServer.post('/mcp', async (request: any, reply: any) => {
      try {
        // SSE transport initialization
        const transport = new SSEServerTransport(request.raw, reply.raw);
        
        // Connect the server to transport
        await this.server.connect(transport);
      } catch (error) {
        console.error('MCP request error:', error);
        if (!reply.sent) {
          reply.code(500).send({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal error",
              data: error instanceof Error ? error.message : String(error),
            },
            id: request.body?.id || null,
          });
        }
      }
    });

    // Start server
    const port = parseInt(process.env.PORT || '3000');
    const host = process.env.HOST || '0.0.0.0';
    
    this.fastifyServer.listen({ port, host }, (err: Error | null) => {
      if (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
      }
      console.log(`🚀 CombinedMemory-v2-SSE server running on http://${host}:${port}`);
      console.log(`📍 Health check: http://${host}:${port}/health`);
      console.log(`🔌 MCP SSE endpoint: http://${host}:${port}/mcp`);
      console.log(`🔑 Bearer token: ${process.env.MCP_BEARER_TOKEN || 'sk-combinedmemory-v2-secure-token-2024'}`);
    });
  }
}

// Start the server
const server = new CombinedMemoryServer();

export default server;