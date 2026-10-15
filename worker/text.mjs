// Small text helpers shared by the worker modules. A leaf module (no imports), so it never creates an import cycle.
const encoder = new TextEncoder();
export const utf8Bytes = text => encoder.encode(text).length;
export const jsonBytes = value => utf8Bytes(JSON.stringify(value));
export const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim();
// One line of at most n characters, the last one '…' when cut.
export const clip = (text, n) => { const t = oneLine(text); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
export const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Month words in questions and documents (Indonesian/English, full and short) and their numbers.
export const MONTHS = {januari:1,january:1,jan:1,februari:2,february:2,feb:2,maret:3,march:3,mar:3,april:4,apr:4,mei:5,may:5,juni:6,june:6,jun:6,juli:7,july:7,jul:7,agustus:8,august:8,agu:8,aug:8,september:9,sep:9,sept:9,oktober:10,october:10,okt:10,oct:10,november:11,nov:11,desember:12,december:12,des:12,dec:12};
export const MONTH_WORDS = Object.keys(MONTHS).join('|');
export const BULAN = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
