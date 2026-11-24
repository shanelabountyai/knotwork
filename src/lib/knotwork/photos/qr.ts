// The QR code of an upload link, as an SVG string made on the server (D-67: `qrcode`). Nothing is fetched from
// anywhere and nothing runs in the browser to draw it.
import { toString as qrToString } from 'qrcode';

export const qrSvg = (url: string): Promise<string> => qrToString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#000000', light: '#ffffff' } });

/** The same SVG as a data: URL, for an <img>: the markup is never injected into a page. */
export const qrDataUrl = async (url: string): Promise<string> => `data:image/svg+xml;base64,${Buffer.from(await qrSvg(url)).toString('base64')}`;
