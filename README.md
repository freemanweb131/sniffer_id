# Sniffer ID - ID Card Mockup Editor

A Next.js application for generating ID card design mockups and authorized test renders using AI image editing via the OpenRouter API.

## Features

- **Drag & drop image upload** with preview
- **Editable card fields**: Name, DOB, Issue, Expiration, Address
- **AI-powered text replacement** through OpenRouter image models
- **Clarity enhancement** toggle for sharper results
- **Side-by-side result preview** with download
- **Guest mode**: 1 free trial stored in `localStorage`
- **Rate limiting**: 5 requests per IP per day
- **Input validation** and prompt-injection sanitization
- **Security disclaimer** footer

## Tech Stack

- Next.js 16 + React 19 + TypeScript
- Tailwind CSS 4
- Zod (validation)
- OpenRouter API (image generation/editing)

## Getting Started

1. Copy the environment file and fill in your OpenRouter API key:

```bash
cp .env.local .env.local
```

Edit `.env.local`:

```env
OPENROUTER_API_KEY=your_openrouter_api_key_here
OPENROUTER_MODEL=google/gemini-2.5-flash-image
OPENROUTER_UPSCALE_MODEL=google/gemini-2.5-flash-image
OPENROUTER_SITE_URL=https://your-domain.com
OPENROUTER_SITE_NAME=Sniffer ID Editor
```

2. Install dependencies:

```bash
npm install
```

3. Run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## API Endpoint

`POST /api/generate`

Accepts a JSON body:

```json
{
  "image": "data:image/png;base64,...",
  "fields": {
    "name": "John Doe",
    "dob": "01/01/1990",
    "iss": "01/01/2024",
    "exp": "01/01/2028",
    "address": "123 Main St, City, ST 12345"
  },
  "enhanceClarity": true
}
```

Returns:

```json
{
  "success": true,
  "image": "https://..."
}
```

## Security Notes

- The OpenRouter API key is stored server-side only.
- All image editing requests go through the Next.js backend.
- Inputs are validated and sanitized to prevent prompt injection.
- A legal disclaimer is displayed to discourage misuse.

## License

MIT - Use responsibly.
