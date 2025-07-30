/**
 * Cloudflare Worker: OpenAI to Gemini API Proxy
 *
 * This worker acts as a proxy that converts API requests from the OpenAI Chat Completions format
 * to the Google Gemini API format. It allows you to use any OpenAI-compatible client
 * with Google's Gemini models.
 *
 * @author Gemini
 * @version 2.0.0
 */

// The official Google Gemini API endpoint.
const GEMINI_API_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight requests to allow cross-origin access.
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }

    const url = new URL(request.url);

    // Ensure the request path matches the expected OpenAI chat completions endpoint.
    if (url.pathname !== '/v1/chat/completions') {
      return createErrorResponse(`Endpoint not found. Please use /v1/chat/completions.`, 404);
    }

    try {
      // Extract the Gemini API key from the Authorization header.
      const apiKey = getApiKey(request);
      if (!apiKey) {
        return createErrorResponse('Authorization header is missing or invalid.', 401);
      }

      // Parse the incoming OpenAI-formatted request body.
      const openaiRequest = await request.json();

      // Convert the OpenAI request to the Gemini format.
      const geminiRequest = openaiToGeminiRequest(openaiRequest);

      // Determine if the request is for streaming.
      const isStream = openaiRequest.stream || false;
      const streamSuffix = isStream ? ':streamGenerateContent' : ':generateContent';
      
      // Construct the full Gemini API URL.
      const model = openaiRequest.model || 'gemini-1.5-flash';
      const geminiUrl = `${GEMINI_API_ENDPOINT}${model}${streamSuffix}?key=${apiKey}`;

      // Call the Gemini API.
      const geminiResponse = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiRequest),
      });

      // Handle potential errors from the Gemini API.
      if (!geminiResponse.ok) {
        const errorBody = await geminiResponse.json();
        console.error('Gemini API Error:', JSON.stringify(errorBody, null, 2));
        return createErrorResponse(errorBody.error.message, geminiResponse.status);
      }

      // Process and return the response based on whether it's streaming or not.
      if (isStream) {
        // If streaming, transform the Gemini SSE stream to the OpenAI SSE format.
        return new Response(geminiResponse.body.pipeThrough(geminiToOpenAIStream()), {
          headers: createCORSHeaders({ 'Content-Type': 'text/event-stream' }),
        });
      } else {
        // If not streaming, convert the full Gemini response to the OpenAI format.
        const geminiJson = await geminiResponse.json();
        const openaiJson = geminiToOpenAIResponse(geminiJson, model);
        return createJsonResponse(openaiJson);
      }

    } catch (e) {
      console.error('Worker Error:', e);
      return createErrorResponse(e.message, 500);
    }
  },
};

/**
 * Handles CORS preflight requests.
 * @returns {Response}
 */
function handleCORS() {
  return new Response(null, {
    headers: createCORSHeaders(),
  });
}

/**
 * Creates a base set of CORS headers.
 * @param {Object} additionalHeaders - Any additional headers to include.
 * @returns {Object}
 */
function createCORSHeaders(additionalHeaders = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...additionalHeaders,
  };
}

/**
 * Extracts the API key from the Authorization header.
 * @param {Request} request
 * @returns {string|null}
 */
function getApiKey(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.substring(7); // "Bearer ".length
}

/**
 * Converts an OpenAI request payload to a Gemini request payload.
 * @param {Object} openaiRequest - The incoming OpenAI-formatted request.
 * @returns {Object} The Gemini-formatted request payload.
 */
function openaiToGeminiRequest(openaiRequest) {
  const geminiRequest = {
    contents: [],
    generationConfig: {},
  };

  // Map OpenAI parameters to Gemini's generationConfig
  if (openaiRequest.max_tokens) {
    geminiRequest.generationConfig.maxOutputTokens = openaiRequest.max_tokens;
  }
  if (openaiRequest.temperature) {
    geminiRequest.generationConfig.temperature = openaiRequest.temperature;
  }
  if (openaiRequest.top_p) {
    geminiRequest.generationConfig.topP = openaiRequest.top_p;
  }
  if (openaiRequest.stop) {
    geminiRequest.generationConfig.stopSequences = Array.isArray(openaiRequest.stop) ? openaiRequest.stop : [openaiRequest.stop];
  }

  // Convert messages to Gemini's `contents` format
  let systemPrompt = null;
  for (const message of openaiRequest.messages) {
    // Handle system prompts: Gemini combines the system prompt with the first user message.
    if (message.role === 'system') {
      systemPrompt = { role: 'user', parts: [{ text: message.content }] };
      continue;
    }
    
    const role = message.role === 'assistant' ? 'model' : 'user';
    
    // If there was a system prompt, prepend it to the first user message.
    if (systemPrompt && role === 'user') {
      geminiRequest.contents.push(systemPrompt);
      systemPrompt = null; // Ensure it's only added once.
    }

    geminiRequest.contents.push({
      role: role,
      parts: [{ text: message.content }],
    });
  }

  return geminiRequest;
}

/**
 * Converts a full Gemini response to the OpenAI Chat Completions format.
 * @param {Object} geminiResponse - The response JSON from Gemini.
 * @param {string} model - The model name used for the request.
 * @returns {Object} The OpenAI-formatted response.
 */
function geminiToOpenAIResponse(geminiResponse, model) {
  const content = geminiResponse.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return {
    id: `chatcmpl-${generateId(12)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
      completion_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: geminiResponse.usageMetadata?.totalTokenCount || 0,
    },
  };
}

/**
 * Creates a TransformStream to convert a Gemini SSE stream to an OpenAI SSE stream.
 * @returns {TransformStream}
 */
function geminiToOpenAIStream() {
  let buffer = '';
  const id = `chatcmpl-${generateId(12)}`;
  const created = Math.floor(Date.now() / 1000);

  return new TransformStream({
    transform(chunk, controller) {
      buffer += new TextDecoder().decode(chunk);
      
      // The Gemini stream uses `\n\n` to separate JSON objects.
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const jsonString = buffer.substring(0, boundary).replace(/^data: /, '');
        buffer = buffer.substring(boundary + 2);
        
        try {
          const geminiChunk = JSON.parse(jsonString);
          const content = geminiChunk.candidates?.[0]?.content?.parts?.[0]?.text || '';
          
          if (content) {
            const openaiChunk = {
              id: id,
              object: 'chat.completion.chunk',
              created: created,
              choices: [
                {
                  index: 0,
                  delta: { content: content },
                  finish_reason: null,
                },
              ],
            };
            controller.enqueue(`data: ${JSON.stringify(openaiChunk)}\n\n`);
          }
        } catch (e) {
          console.error('Error parsing Gemini stream chunk:', e);
        }
        
        boundary = buffer.indexOf('\n\n');
      }
    },
    flush(controller) {
      // When the stream is finished, send the [DONE] signal.
      const doneChunk = {
        id: id,
        object: 'chat.completion.chunk',
        created: created,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      };
      controller.enqueue(`data: ${JSON.stringify(doneChunk)}\n\n`);
      controller.enqueue('data: [DONE]\n\n');
    },
  });
}

/**
 * Creates a standard JSON response.
 * @param {Object} json - The JSON object to send.
 * @param {number} status - The HTTP status code.
 * @returns {Response}
 */
function createJsonResponse(json, status = 200) {
  return new Response(JSON.stringify(json, null, 2), {
    status: status,
    headers: createCORSHeaders({ 'Content-Type': 'application/json' }),
  });
}

/**
 * Creates an OpenAI-compatible error response.
 * @param {string} message - The error message.
 * @param {number} status - The HTTP status code.
 * @returns {Response}
 */
function createErrorResponse(message, status) {
  const errorJson = {
    error: {
      message: message,
      type: 'proxy_error',
      code: status,
    },
  };
  return createJsonResponse(errorJson, status);
}

/**
 * Generates a random alphanumeric ID.
 * @param {number} length - The desired length of the ID.
 * @returns {string}
 */
function generateId(length) {
  let result = '';
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}
