import { run, save } from './gp.mjs';
const RAW = 'https://raw.githubusercontent.com/Aaronlawrencedesigns/test/claude/amazing-cori-evd2ow/assets/keyframes/';
const [name, first, last, duration, ...promptParts] = process.argv.slice(2);
const prompt = promptParts.join(' ') +
  ' Static locked-off camera, no zoom, no camera movement. Keep the flat chroma-key green screen background exactly as it is, no shadows. Photorealistic, natural real dog motion.';
const body = { prompt, image: RAW + first + '.png', aspect_ratio: '1:1', duration: +duration, resolution: '720p', generate_audio: false, camera_fixed: true, is_upload_media: false, seed: -1 };
if (last && last !== '-') { body.last_image = RAW + last + '.png'; delete body.camera_fixed; }
const t0 = Date.now();
const d = await run(process.env.VMODEL || 'doubao/dreamina-seedance-2-0-mini-260615/image-to-video', body, { pollMs: 8000, timeoutMs: 50 * 60e3 });
console.log(name, 'done', ((Date.now() - t0) / 1000) | 0, 's', d.outputs[0]);
await save(d.outputs[0], `clips/${name}.mp4`);
console.log('saved', `clips/${name}.mp4`);
