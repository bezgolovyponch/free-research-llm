export const GUIDES_CHECKED = '2026-10-19';

const PASTE = (env) => `Save it as ${env}: on Models & router paste it into that card and press Connect & test, or in the Terminal run node src/frl.mjs keys set ${env}. The app tests it with the provider before saving it in your key store.`;

export const KEY_GUIDES = {
  GEMINI_API_KEY: {
    url: 'https://aistudio.google.com/apikey',
    steps: ['Open https://aistudio.google.com/apikey and sign in with a Google account.', 'Press "Create API key". New users get a default Google Cloud project automatically; existing users may first need "Import projects".', 'Copy the key.', PASTE('GEMINI_API_KEY')],
    card: false,
    source: 'https://ai.google.dev/gemini-api/docs/api-key',
  },
  GROQ_API_KEY: {
    url: 'https://console.groq.com/keys',
    steps: ['Open https://console.groq.com/keys and sign in (Google, GitHub or email).', 'Press "Create API Key", give it a name, and confirm.', 'Copy the key (it starts with gsk_). It is shown only once.', PASTE('GROQ_API_KEY')],
    prefix: 'gsk_',
    card: false,
    source: 'https://console.groq.com/docs/quickstart',
  },
  CEREBRAS_API_KEY: {
    url: 'https://cloud.cerebras.ai',
    steps: ['Open https://cloud.cerebras.ai and sign up or log in.', 'Choose "API Keys" in the left menu.', 'Create a key and copy it (it starts with csk-).', PASTE('CEREBRAS_API_KEY')],
    prefix: 'csk-',
    card: false,
    source: 'https://inference-docs.cerebras.ai/quickstart',
  },
  MISTRAL_API_KEY: {
    url: 'https://console.mistral.ai/api-keys',
    steps: ['Open https://console.mistral.ai and sign up. Choose the free "Experiment" plan when asked; Mistral verifies your phone number.', 'Choose "API Keys" in the left sidebar, then "Create new key".', 'Enter a Name, set an Expiration, keep "Shared connectors only", and press "Create new key".', 'Copy the key now: it appears only once.', PASTE('MISTRAL_API_KEY')],
    card: false,
    note: 'On the free plan your requests may be used for training.',
    source: 'https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key',
  },
  NVIDIA_API_KEY: {
    url: 'https://build.nvidia.com/settings/api-keys',
    steps: ['Open https://build.nvidia.com and press "Get API Key" (top right, or on any model page).', 'Enter your email, press "Next", and create or sign in to your NVIDIA account (email check, no card).', 'Open https://build.nvidia.com/settings/api-keys and press "Generate Key".', 'Copy the key (it starts with nvapi-). NVIDIA shows it only once.', PASTE('NVIDIA_API_KEY')],
    prefix: 'nvapi-',
    card: false,
    source: 'https://docs.api.nvidia.com/nim/docs/api-quickstart',
  },
  SAMBANOVA_API_KEY: {
    url: 'https://cloud.sambanova.ai/apis',
    steps: ['Open https://cloud.sambanova.ai and sign up or log in.', 'Open the API section: https://cloud.sambanova.ai/apis.', 'Generate a key (up to 25 per account) and copy it: it cannot be viewed again.', PASTE('SAMBANOVA_API_KEY')],
    card: false,
    source: 'https://docs.sambanova.ai/docs/en/get-started/api-keys-urls',
  },
  OPENROUTER_API_KEY: {
    url: 'https://openrouter.ai/keys',
    steps: ['Open https://openrouter.ai and sign in.', 'Open https://openrouter.ai/keys and press "Create Key".', 'Give it a name. Optionally set a small credit limit; the :free models the app uses cost nothing.', 'Copy the key (it starts with sk-or-).', PASTE('OPENROUTER_API_KEY')],
    prefix: 'sk-or-',
    card: false,
    note: 'Free models allow 50 requests a day; 1,000 a day after a one-time $10 credit purchase.',
    source: 'https://openrouter.ai/docs/api-reference/authentication',
  },
  CLOUDFLARE_ACCOUNT_ID: {
    url: 'https://dash.cloudflare.com',
    steps: ['Sign in at https://dash.cloudflare.com (a free account is enough).', 'Open the Workers AI page in the dashboard and press "Use REST API".', 'Under "Get Account ID", copy the Account ID.'],
    card: false,
    source: 'https://developers.cloudflare.com/workers-ai/get-started/rest-api/',
  },
  CLOUDFLARE_API_TOKEN: {
    url: 'https://dash.cloudflare.com',
    steps: ['On the same "Use REST API" page, press "Create a Workers AI API Token".', 'Press "Create API Token", then "Copy API Token".', 'Save both: on Models & router paste the account ID and the token into the Cloudflare card and press Connect & test, or run node src/frl.mjs keys set CLOUDFLARE_ACCOUNT_ID and node src/frl.mjs keys set CLOUDFLARE_API_TOKEN.'],
    card: false,
    source: 'https://developers.cloudflare.com/workers-ai/get-started/rest-api/',
  },
  COHERE_API_KEY: {
    url: 'https://dashboard.cohere.com/api-keys',
    steps: ['Sign up at https://dashboard.cohere.com.', 'Open https://dashboard.cohere.com/api-keys and copy the trial key (or create a new trial key).', PASTE('COHERE_API_KEY')],
    card: false,
    note: 'Trial keys: 1,000 calls a month, 20 chat requests a minute.',
    source: 'https://docs.cohere.com/docs/rate-limits',
  },
  PUTER_AUTH_TOKEN: {
    url: 'https://puter.com/dashboard#account',
    steps: ['Sign in at https://puter.com.', 'Open https://puter.com/dashboard#account.', 'In "Auth Token", press "Copy".', PASTE('PUTER_AUTH_TOKEN')],
    card: false,
    note: 'This token can act as you on Puter: treat it like a password.',
    source: 'https://developer.puter.com/tutorials/puter-auth-token/',
  },
  CUSTOM_LLM_API_KEY: {
    url: 'https://github.com/tashfeenahmed/freellmapi',
    steps: ['Follow FREE-ROUTING.md: install FreeLLMAPI (curl -fsSL https://freellmapi.co/install.sh | bash on macOS/Linux, or the .exe from its Releases page on Windows).', 'Open http://localhost:3001, add your free keys on its Keys page, and copy the unified freellmapi-… key from the header.', 'On Models & router, Custom card: base URL http://localhost:3001/v1, model auto, key the freellmapi-… key; press Connect & test.'],
    card: false,
    source: 'https://github.com/tashfeenahmed/freellmapi',
  },
  LLAMACPP_BASE_URL: {
    url: 'https://github.com/ggml-org/llama.cpp/releases',
    steps: ['In the app Terminal run: node src/frl.mjs local install', 'Then: node src/frl.mjs local models --vram <your GPU GB>', 'Then, in a second Terminal session: node src/frl.mjs local start --model <the model it printed>', 'It saves http://127.0.0.1:8090/v1 here by itself. Full guide: LOCAL-GPU.md.'],
    card: false,
    source: 'https://github.com/ggml-org/llama.cpp/blob/master/tools/rpc/README.md',
  },
  OLLAMA_BASE_URL: {
    url: 'https://ollama.com/download',
    steps: ['Install Ollama from https://ollama.com/download.', 'In a terminal: ollama pull qwen2.5:7b', 'Leave Ollama running; the app finds it at http://localhost:11434/v1 without any field.'],
    card: false,
    source: 'https://ollama.com/download',
  },
  LANGSEARCH_API_KEY: {
    url: 'https://langsearch.com/dashboard',
    steps: ['Sign up at https://langsearch.com and open https://langsearch.com/dashboard.', 'Open "API Keys", create a key, and copy it.', PASTE('LANGSEARCH_API_KEY')],
    card: false,
    source: 'https://docs.langsearch.com/',
  },
  TAVILY_API_KEY: {
    url: 'https://app.tavily.com',
    steps: ['Sign up at https://app.tavily.com (no card).', 'Copy the API key shown on the dashboard (it starts with tvly-).', PASTE('TAVILY_API_KEY')],
    prefix: 'tvly-',
    card: false,
    note: '1,000 free credits every month.',
    source: 'https://docs.tavily.com/documentation/quickstart',
  },
  EXA_API_KEY: {
    url: 'https://dashboard.exa.ai/api-keys',
    steps: ['Sign up at https://dashboard.exa.ai.', 'Open https://dashboard.exa.ai/api-keys and create a key.', PASTE('EXA_API_KEY')],
    card: false,
    source: 'https://exa.ai/docs/reference/getting-started',
  },
  LINKUP_API_KEY: {
    url: 'https://app.linkup.so',
    steps: ['Create a free account at https://app.linkup.so.', 'Copy the API key from your dashboard.', PASTE('LINKUP_API_KEY')],
    card: false,
    source: 'https://docs.linkup.so/pages/documentation/get-started/quickstart',
  },
  JINA_API_KEY: {
    url: 'https://jina.ai/api-dashboard',
    steps: ['Open https://jina.ai/api-dashboard and sign in.', 'Copy your API key from the dashboard (it starts with jina_).', PASTE('JINA_API_KEY')],
    prefix: 'jina_',
    card: false,
    note: '10M free tokens once (about 1,000 searches).',
    source: 'https://jina.ai/api-dashboard',
  },
  FIRECRAWL_API_KEY: {
    url: 'https://www.firecrawl.dev/app/api-keys',
    steps: ['Create a free account at https://www.firecrawl.dev.', 'Open https://www.firecrawl.dev/app/api-keys and copy the key (it starts with fc-).', PASTE('FIRECRAWL_API_KEY')],
    prefix: 'fc-',
    card: false,
    source: 'https://docs.firecrawl.dev/introduction',
  },
  SERPER_API_KEY: {
    url: 'https://serper.dev/api-keys',
    steps: ['Sign up at https://serper.dev (2,500 free queries once, no card).', 'Open https://serper.dev/api-keys and copy the key.', PASTE('SERPER_API_KEY')],
    card: false,
    source: 'https://serper.dev/',
  },
  BRAVE_API_KEY: {
    url: 'https://api-dashboard.search.brave.com',
    steps: ['Needs a credit card. Register at https://api-dashboard.search.brave.com.', 'Open "Plans" and activate the Search plan with your card.', 'Open "API Keys", press "Add API Key", name it, and copy it.', PASTE('BRAVE_API_KEY')],
    card: true,
    source: 'https://api-dashboard.search.brave.com/documentation/quickstart',
  },
  SEARXNG_URL: {
    url: 'https://www.docker.com/products/docker-desktop/',
    steps: ['Install Docker Desktop from https://www.docker.com/products/docker-desktop/ and start it; wait for "Engine running".', 'In the app Terminal run: node src/frl.mjs searxng (or press "Start SearXNG search").', 'It starts SearXNG on http://127.0.0.1:8888 and saves SEARXNG_URL by itself.'],
    card: false,
    source: 'https://docs.searxng.org/admin/installation-docker.html',
  },
};

export function guideFor(env) {
  return KEY_GUIDES[env] ?? null;
}

export function guidesFor(names) {
  return names.filter(Boolean).map((env) => ({ env, ...KEY_GUIDES[env] })).filter((g) => g.steps);
}
