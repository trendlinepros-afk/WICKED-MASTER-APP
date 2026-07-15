import type { ContentPart, Provider } from '../types';

export interface ModelSuggestion {
  provider: Provider;
  modelVersion: string;
  label: string; // human label, e.g. "DeepSeek R1"
  reason: string;
}

const IMAGE_NOUN = '(image|picture|photo|logo|art|artwork|illustration|icon|wallpaper|drawing|graphic|sticker|avatar|banner|poster|mockup)';

// Does this text read like a request to GENERATE an image (vs. discuss one)?
export function isImageRequest(text: string): boolean {
  const t = text.toLowerCase();
  return (
    new RegExp(`\\b(generate|create|draw|make|render|design|need|want|build|give me|sketch)\\b[\\s\\S]{0,40}\\b${IMAGE_NOUN}\\b`).test(t) ||
    new RegExp(`\\b${IMAGE_NOUN}\\s+(of|for|that|with|showing|in)\\b`).test(t) ||
    /\b(image|picture|photo) of\b/.test(t)
  );
}

// Purely local heuristics — no API call. Returns a suggestion only when there's
// a reasonably strong signal that a different model would serve the request better.
export function suggestModel(parts: ContentPart[]): ModelSuggestion | null {
  const text = parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('\n')
    .toLowerCase();
  const hasImage = parts.some((p) => p.type === 'image_url');

  // 1. Image attached → needs a vision-capable model.
  if (hasImage) {
    return {
      provider: 'openai',
      modelVersion: 'gpt-4o',
      label: 'GPT-4o',
      reason: 'You attached an image — GPT-4o reads images well.',
    };
  }

  // 2. Explicit image-generation intent → Gemini Imagen.
  if (isImageRequest(text)) {
    return {
      provider: 'gemini',
      modelVersion: 'imagen-3.0-generate-002',
      label: 'Imagen (image gen)',
      reason: 'Looks like you want to generate an image — switch on Gemini Image Gen.',
    };
  }

  // 3. Hard reasoning / math / proofs → a reasoning model.
  if (/\b(prove|proof|theorem|derive|solve|equation|algorithm|complexity|optimi[sz]e|step by step|reason through|logic puzzle|math)\b/.test(text)) {
    return {
      provider: 'deepseek',
      modelVersion: 'deepseek-reasoner',
      label: 'DeepSeek R1',
      reason: 'This looks reasoning-heavy — DeepSeek R1 thinks step by step.',
    };
  }

  // 4. Coding / debugging → strong coding model.
  const codeSignals = /\b(code|function|debug|bug|stack trace|exception|refactor|typescript|python|rust|javascript|compile|build error|regex|api|sql|godot|gdscript)\b/;
  if (codeSignals.test(text) || /```/.test(text)) {
    return {
      provider: 'deepseek',
      modelVersion: 'deepseek-chat',
      label: 'DeepSeek V3',
      reason: 'Coding task detected — DeepSeek V3 is strong and cheap for code.',
    };
  }

  // 5. Very long / document-style input → large-context flash model.
  if (text.length > 4000) {
    return {
      provider: 'gemini',
      modelVersion: 'gemini-1.5-pro',
      label: 'Gemini 1.5 Pro',
      reason: 'Long input — Gemini 1.5 Pro has a large context window.',
    };
  }

  return null;
}
