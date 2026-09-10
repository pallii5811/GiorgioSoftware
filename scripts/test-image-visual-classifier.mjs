import assert from "node:assert/strict";
import sharp from "sharp";

const { analyzeImageVisualContent } = await import(
  "../src/lib/sanita/ocr.ts"
);

const documentSvg = Buffer.from(
  `<svg width="707" height="998" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="white"/>
    <text x="50" y="80" font-size="32">POLIZZA RCT 123456</text>
    ${Array.from(
      { length: 35 },
      (_, index) =>
        `<rect x="50" y="${120 + index * 22}" width="${
          400 + (index % 4) * 40
        }" height="5" fill="#222"/>`
    ).join("")}
  </svg>`
);
const documentBuffer = await sharp(documentSvg).png().toBuffer();
const documentAnalysis = await analyzeImageVisualContent(documentBuffer);
assert.ok(documentAnalysis);
assert.equal(
  documentAnalysis.stronglyPhotographic,
  false,
  JSON.stringify(documentAnalysis)
);
assert.equal(
  documentAnalysis.clearlyNonDocumentMedia,
  false,
  JSON.stringify(documentAnalysis)
);

const iconBuffer = await sharp(
  Buffer.from(
    `<svg width="120" height="120" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="transparent"/>
      <circle cx="60" cy="60" r="35" fill="#2474a6"/>
    </svg>`
  )
)
  .png()
  .toBuffer();
const iconAnalysis = await analyzeImageVisualContent(iconBuffer);
assert.ok(iconAnalysis);
assert.equal(
  iconAnalysis.clearlyNonDocumentMedia,
  true,
  JSON.stringify(iconAnalysis)
);

let seed = 123456789;
const photoRaw = Buffer.alloc(1200 * 800 * 3);
for (let index = 0; index < photoRaw.length; index++) {
  seed = (1664525 * seed + 1013904223) >>> 0;
  photoRaw[index] = seed >>> 24;
}
const photoBuffer = await sharp(photoRaw, {
  raw: { width: 1200, height: 800, channels: 3 },
})
  .blur(1)
  .jpeg({ quality: 85 })
  .toBuffer();
const photoAnalysis = await analyzeImageVisualContent(photoBuffer);
assert.ok(photoAnalysis);
assert.equal(
  photoAnalysis.stronglyPhotographic,
  true,
  JSON.stringify(photoAnalysis)
);

const brightPortraitRaw = Buffer.alloc(600 * 800 * 3);
for (let index = 0; index < brightPortraitRaw.length; index++) {
  seed = (1664525 * seed + 1013904223) >>> 0;
  brightPortraitRaw[index] = 150 + ((seed >>> 24) % 90);
}
const brightPortraitBuffer = await sharp(brightPortraitRaw, {
  raw: { width: 600, height: 800, channels: 3 },
})
  .blur(1)
  .jpeg({ quality: 85 })
  .toBuffer();
const brightPortraitAnalysis =
  await analyzeImageVisualContent(brightPortraitBuffer);
assert.ok(brightPortraitAnalysis);
assert.equal(
  brightPortraitAnalysis.clearlyNonDocumentMedia,
  true,
  JSON.stringify(brightPortraitAnalysis)
);

const wideLogoBuffer = await sharp(
  Buffer.from(
    `<svg width="2400" height="480" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#f3f7fb"/>
      <circle cx="300" cy="240" r="130" fill="#3b82a0"/>
      <text x="520" y="285" font-size="150" fill="#18425a">CLINICA</text>
    </svg>`
  )
)
  .png()
  .toBuffer();
const wideLogoAnalysis = await analyzeImageVisualContent(wideLogoBuffer);
assert.ok(wideLogoAnalysis);
assert.equal(
  wideLogoAnalysis.clearlyNonDocumentMedia,
  true,
  JSON.stringify(wideLogoAnalysis)
);

const cutoutPhoto = await sharp(photoBuffer)
  .resize(600, 600, { fit: "cover" })
  .png()
  .toBuffer();
const transparentCutout = await sharp({
  create: {
    width: 900,
    height: 700,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite([
    {
      input: cutoutPhoto,
      left: 150,
      top: 50,
    },
  ])
  .png()
  .toBuffer();
const transparentCutoutAnalysis =
  await analyzeImageVisualContent(transparentCutout);
assert.ok(transparentCutoutAnalysis);
assert.equal(
  transparentCutoutAnalysis.clearlyNonDocumentMedia,
  true,
  JSON.stringify(transparentCutoutAnalysis)
);

console.log(
  JSON.stringify({
    suite: "image-visual-classifier",
    pass: 6,
    fail: 0,
    exitCode: 0,
    document: documentAnalysis,
    photo: photoAnalysis,
    brightPortrait: brightPortraitAnalysis,
    wideLogo: wideLogoAnalysis,
    transparentCutout: transparentCutoutAnalysis,
  })
);
