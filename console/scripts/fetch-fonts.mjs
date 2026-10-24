// Downloads Switzer for next/font/local at build time.
//
// Switzer is licensed under the ITF Free Font License 2.0, which permits
// self-hosting but forbids making the font files available through a
// repository or on publicly accessible servers. So the files are never
// committed: this script fetches the official files from Fontshare into a
// gitignored folder, and the build serves them as the site's own fonts.
//
// Each file is pinned by sha256. If Fontshare ever serves different bytes, the
// build fails here rather than shipping a font nobody checked.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "fonts", "switzer");
const MAX_BYTES = 200_000;

const FILES = [
  {
    name: "Switzer-Regular.woff2",
    url: "https://cdn.fontshare.com/wf/BLNB4FAQFNK56DWWNF7PMGTCOTZHOEII/ST3WKSSDMBK2MIQQO3MAVYWLF4FTOLFV/6IN5WOLRCYP4G4MOCOHOMXNON6Q7MDAR.woff2",
    sha256: "ddd9595560c35725e00d01667ce9bee519d245620e610844f0dd149df10b5d5f",
  },
  {
    name: "Switzer-Medium.woff2",
    url: "https://cdn.fontshare.com/wf/OYB4CXKJQXKTNSLJMTDQOIVUL2V5EL7S/WYO2P7DQVV5RNXGMCUO2HL4RJP4VFUAS/6XPIMU23OJVRY676OG5YVJMWEHWICATX.woff2",
    sha256: "7393d1abac009ede0da9f95d6c83479a08d798e28d3509575e02fb1d2346866f",
  },
  {
    name: "Switzer-Semibold.woff2",
    url: "https://cdn.fontshare.com/wf/5SZVFDB7V52TI6ULVC6J3WQZQCIZVDV5/ODYPSTCUDMKSTYIPTV4CLQ7URIK7XYBJ/YS3VPNVO4B3TOJMEXDGFZQ4TLZGGSRZC.woff2",
    sha256: "d6497c264dbf70ae51add5103b6c7553dadff334b5853d09adf8c9f1c63ad36b",
  },
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

mkdirSync(OUT, { recursive: true });
for (const file of FILES) {
  const target = join(OUT, file.name);
  if (existsSync(target) && sha256(readFileSync(target)) === file.sha256) continue;

  const res = await fetch(file.url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${file.name}: Fontshare answered http ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error(`${file.name}: ${bytes.length} bytes, over the ${MAX_BYTES} limit`);
  if (bytes.subarray(0, 4).toString("latin1") !== "wOF2") throw new Error(`${file.name}: not a WOFF2 file`);
  const got = sha256(bytes);
  if (got !== file.sha256) {
    throw new Error(`${file.name}: sha256 ${got} does not match the pinned ${file.sha256}. Check the new file before updating the pin.`);
  }
  writeFileSync(target, bytes);
  console.log(`fetched ${file.name} (${bytes.length} bytes, sha256 verified)`);
}
