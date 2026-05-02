# Language Learning Media Editor

Language Learning Media Editor is a local desktop app for creating language learning lessons from your own audio and video files.

It is designed for sentence mining, clip-based study, transcription, translation notes, and exporting reusable lesson or sentence packages.

## Download

Download the latest Windows build from GitHub Releases:

https://github.com/yujiunn20/language-media-editor/releases/latest

For Windows, download the installer:

```text
Language Media Editor Setup <version>.exe
```

You can also download the portable ZIP build if you prefer not to use the installer.

## Features

- Import your own audio and video files
- Create timestamped clips from media
- Add source sentences, translations, categories, and notes
- Transcribe selected audio clips locally
- Save useful clips into a Sentence Book with extracted audio
- Search, edit, export, and import Sentence Book entries
- Export lessons and sentence collections as ZIP packages
- Import exported lesson and sentence ZIP packages
- Prevent duplicate lesson titles and duplicate sentences
- UI language support: English, Chinese, and Japanese

## Privacy

This app runs locally on your device.

Imported media, lesson data, sentence book entries, generated audio, and UI settings are stored locally. The app does not upload your media or sentence data to the developer's servers.

Users are responsible for ensuring that any media, text, translation, subtitle, lesson, or sentence audio they import, create, edit, or export is content they own, are licensed to use, or are otherwise legally permitted to use.

## Third-party Licenses

The app includes an in-app `Third-party licenses` page with notices for bundled and used components, including FFmpeg, whisper.cpp, OpenAI Whisper model files, Electron, Express, better-sqlite3, multer, and mime-types.

FFmpeg is distributed under GPLv3-or-later through the bundled `ffmpeg-static` package. See the in-app license page for source and license links.

## Development

Install dependencies:

```powershell
npm ci
```

Run the local server:

```powershell
npm start
```

Run the Electron app:

```powershell
npm run electron
```

Build release packages:

```powershell
npm run dist:win
npm run dist:linux
```

## Release

Releases are built by GitHub Actions when a `v*` tag is pushed.

Example:

```powershell
git add .
git commit -m "Release v1.0.7"
git tag v1.0.7
git push origin microsoft-store
git push origin v1.0.7
```

## License

See the repository license file.
