export const PROVIDER_PRESETS = [
  {
    id: 'groq',
    label: 'Groq (free tier)',
    baseURL: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    signup: 'https://console.groq.com/keys',
    prefer: {
      fast: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'],
      deep: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'qwen/qwen3-32b'],
    },
  },
  {
    id: 'cerebras',
    label: 'Cerebras (free tier)',
    baseURL: 'https://api.cerebras.ai/v1',
    keyEnv: 'CEREBRAS_API_KEY',
    signup: 'https://cloud.cerebras.ai',
    prefer: {
      fast: ['gpt-oss-120b', 'qwen-3.8-27b', 'qwen', 'llama'],
      deep: ['gpt-oss-120b', 'qwen-3.8-27b', 'kimi', 'qwen', 'llama'],
    },
    fallbackModels: { fast: 'gpt-oss-120b', deep: 'gpt-oss-120b' },
  },
  {
    id: 'gemini',
    label: 'Google Gemini (free tier)',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    signup: 'https://aistudio.google.com/apikey',
    prefer: {
      fast: ['gemini-3.8-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'flash'],
      deep: ['gemini-3.8-flash', 'gemini-3-pro', 'gemini-2.5-pro', 'gemini-2.5-flash', 'flash'],
    },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (:free models)',
    baseURL: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    signup: 'https://openrouter.ai/settings/keys',
    freeOnly: true,
    prefer: {
      fast: ['meta-llama/llama-3.3-70b-instruct:free', 'qwen/qwen3', 'deepseek'],
      deep: ['deepseek/deepseek-r1:free', 'deepseek/deepseek-chat-v3', 'deepseek', 'qwen/qwen3', 'llama-3.3-70b'],
    },
  },
  {
    id: 'ollama',
    label: 'Ollama (local, no key)',
    baseURL: 'http://localhost:11434/v1',
    baseEnv: 'OLLAMA_BASE_URL',
    keyEnv: null,
    signup: 'https://ollama.com/download',
    local: true,
    prefer: {
      fast: ['qwen2.5:3b', 'llama3.2:3b', 'qwen2.5', 'llama3'],
      deep: ['qwen2.5:7b', 'llama3.1:8b', 'qwen2.5', 'llama3'],
    },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek (near-free, paid)',
    baseURL: 'https://api.deepseek.com/v1',
    keyEnv: 'DEEPSEEK_API_KEY',
    signup: 'https://platform.deepseek.com/api_keys',
    paid: true,
    prefer: {
      fast: ['deepseek-chat'],
      deep: ['deepseek-chat', 'deepseek-reasoner'],
    },
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible endpoint',
    baseURL: '',
    baseEnv: 'CUSTOM_LLM_BASE_URL',
    keyEnv: 'CUSTOM_LLM_API_KEY',
    modelEnv: 'CUSTOM_LLM_MODEL',
    signup: '',
    prefer: { fast: [], deep: [] },
  },
];

export const NON_CHAT_MODEL = /embed|whisper|tts|audio|image|vision-only|guard|moderation|rerank|transcribe|aqa|imagen|veo|lyria|native-audio|computer-use|robotics/i;
