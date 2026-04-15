# gemma-wrap

A desktop chat interface for [Gemma4](https://ollama.com/library/gemma4) running locally via [Ollama](https://ollama.com), built with Electron.

## Features
- 💬 Multi-conversation chat with persistent history
- 🔍 Web search via Brave Search API (tool-calling)
- 📎 File attachment (drag & drop or paperclip button)
- 🔄 Model switcher (swap between any Ollama model)
- ⚙️ System prompt, temperature & token controls

## Requirements
- [Node.js](https://nodejs.org)
- [Ollama](https://ollama.com) running locally with Gemma4: `ollama pull gemma4`
- (Optional) [Brave Search API key](https://brave.com/search/api/) for web search

## Setup
```bash
npm install
cp config.example.json config.json   # add your Brave API key
npm start -- --no-sandbox            # --no-sandbox required on Linux
```

## Config
Create `config.json` (gitignored):
```json
{ "braveApiKey": "YOUR_KEY_HERE" }
```
