function cleanAllofyFormatting(value) {
  return String(value || '')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, '$1$2')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/gm, '')
    .replace(/R\$\s*([\d.]+),\?/g, 'valor não confirmado ($1 reais)')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { cleanAllofyFormatting };
