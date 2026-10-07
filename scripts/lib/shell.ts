// A value placed inside a suggested command is quoted so a shell reads it back as one plain word.
export const shellQuote = (value: string): string => (/^[A-Za-z0-9._@%+:=,/-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);
