export const pipedShell = process.platform === 'win32'
  ? { platform: 'win32', file: 'powershell.exe', product: (tag: string, a: number, b: number) => `Write-Output "${tag}_$(${a}*${b})"\r` }
  : { platform: 'linux', file: '/bin/sh', product: (tag: string, a: number, b: number) => `echo ${tag}_$((${a}*${b}))\r` };

export async function waitFor(done: () => boolean, ms = 15000) {
  for (const until = Date.now() + ms; !done() && Date.now() < until;) await new Promise((r) => setTimeout(r, 20));
}
