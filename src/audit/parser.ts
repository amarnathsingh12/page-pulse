import { Parser } from 'htmlparser2';

export interface ParsedHtml {
  title: string | null;
  metaDescription: string | null;
  h1Count: number;
}

function decode(buffer: Buffer, charset: string | null): string {
  const label = charset && charset.length > 0 ? charset : 'utf-8';
  try {
    return new TextDecoder(label).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

export function parseHtml(buffer: Buffer, charset: string | null): ParsedHtml {
  const html = decode(buffer, charset);

  let title: string | null = null;
  let metaDescription: string | null = null;
  let h1Count = 0;
  let inHead = false;
  let inTitle = false;
  let titleDone = false;

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === 'head') inHead = true;
        if (name === 'title' && inHead && !titleDone) {
          inTitle = true;
          title = '';
        }
        if (name === 'meta') {
          const metaName = (attrs.name ?? attrs.NAME ?? '').toLowerCase();
          if (metaName === 'description' && metaDescription === null) {
            metaDescription = (attrs.content ?? '').trim();
          }
        }
        if (name === 'h1') h1Count += 1;
      },
      ontext(text) {
        if (inTitle) title = (title ?? '') + text;
      },
      onclosetag(name) {
        if (name === 'title') {
          inTitle = false;
          titleDone = true;
        }
        if (name === 'head') inHead = false;
      },
    },
    { decodeEntities: true },
  );

  parser.write(html);
  parser.end();

  return {
    title: title !== null ? (title as string).trim() : null,
    metaDescription,
    h1Count,
  };
}
