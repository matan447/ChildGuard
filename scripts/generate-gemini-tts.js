const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FFMPEG_PATH =
  process.env.FFMPEG_PATH ||
  'C:\\Users\\Asus-pc\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffmpeg.exe';

function loadGeminiApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const candidates = [
    path.resolve(__dirname, '..', '.env'),
    path.resolve(__dirname, '..', '..', 'nettobox', '.env')
  ];
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/^GEMINI_API_KEY=(.+)$/m);
      if (match && match[1].trim()) return match[1].trim();
    }
  }
  return '';
}

const TRACKS = [
  {
    file: 'alert-stop.mp3',
    style: 'warm, clear, urgent and natural Israeli female voice speaking Hebrew',
    text: 'תשומת לב! הנסיעה הסתיימה. אנא בדקו עכשיו את המושב האחורי, וודאו שאין ילד ברכב לפני היציאה.'
  },
  {
    file: 'alert-broken-routine.mp3',
    style: 'urgent, firm, clear and caring Israeli female voice speaking Hebrew',
    text: 'אזהרה דחופה! חניתם במקום העבודה ללא עצירה בגן הבוקר! אנא בדקו מיד את המושב האחורי, וודאו שהילד לא נשאר ברכב!'
  },
  {
    file: 'alert-low-battery.mp3',
    style: 'calm, helpful, clear Israeli female voice speaking natural Hebrew',
    text: 'שימו לב, הסוללה בטלפון חלשה מאוד. אנא חברו עכשיו את הטלפון למטען הרכב, כדי שהתרעת הילדים תפעל בסיום הנסיעה.'
  },
  {
    file: 'alert-heatwave.mp3',
    style: 'urgent, serious, clear Israeli female voice speaking natural Hebrew',
    text: 'אזהרת חום קיצוני! הטמפרטורה בחוץ גבוהה מאוד. בדקו מיד את המושב האחורי ואשרו שהרכב ריק!'
  }
];

async function synthesizeTrack(apiKey, audioDir, track, voiceName) {
  console.log(`[Gemini 3.8 Flash TTS] Generating ${track.file} (voice=${voiceName})...`);
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      model: 'gemini-3.8-flash-tts',
      input: [
        {
          type: 'user_input',
          content: [
            {
              type: 'text',
              text: track.text,
              annotations: [
                {
                  type: 'speech_metadata',
                  style: track.style
                }
              ]
            }
          ]
        }
      ],
      response_format: { type: 'audio' },
      generation_config: {
        speech_config: [{ voice: voiceName }]
      }
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Gemini TTS error (${res.status}) for ${track.file}: ${JSON.stringify(data)}`);
  }

  const outputs = data.steps?.filter((s) => s.type === 'model_output') || [];
  let audioBase64 = null;
  for (const out of outputs) {
    const part = out.content?.find((c) => c.type === 'audio');
    if (part?.data) audioBase64 = part.data;
  }
  if (!audioBase64) {
    throw new Error(`No audio data in Gemini response for ${track.file}`);
  }

  const tempWav = path.join(audioDir, `${track.file}.wav`);
  const outMp3 = path.join(audioDir, track.file);
  fs.writeFileSync(tempWav, Buffer.from(audioBase64, 'base64'));
  execFileSync(FFMPEG_PATH, ['-i', tempWav, '-q:a', '2', '-y', outMp3], { stdio: 'ignore' });
  fs.unlinkSync(tempWav);

  const stats = fs.statSync(outMp3);
  console.log(`  ✓ Saved ${track.file} (${stats.size} bytes)`);
}

async function main() {
  const apiKey = loadGeminiApiKey();
  if (!apiKey) {
    console.error('Missing GEMINI_API_KEY in env, ./.env, or ../nettobox/.env');
    process.exit(1);
  }
  const voiceName = process.argv[2] || 'Aoede';
  const audioDir = path.resolve(__dirname, '..', 'assets', 'audio');
  fs.mkdirSync(audioDir, { recursive: true });

  for (const track of TRACKS) {
    await synthesizeTrack(apiKey, audioDir, track, voiceName);
  }
  console.log('All Gemini TTS female voice tracks generated successfully.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
