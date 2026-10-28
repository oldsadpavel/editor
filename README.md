# Claude Editor

A PhpStorm-style code editor built around Claude Code. It runs several Claude chats per project at once. Each chat keeps its own history, and all chats share the project's memory. The editor also shows which files each answer changed, and tracks git pushes through CI to the live site with smoke tests. Panels for problems, keys, deploys and tests light up when something needs attention.

```
npm install
npm start          # build and run
npm run dist       # portable Windows .exe in release/
```

Requires Claude Code (`claude`) installed and logged in; the app can start `claude auth login` for you.

Full guide in Russian: [docs/ИНСТРУКЦИЯ.md](docs/ИНСТРУКЦИЯ.md).
