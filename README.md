# mdsync

Turn markdown files into beautiful, editable documents in the browser. Zero config.

```
npx markdownsync README.md
```

That's it. Your markdown is now a rendered document at `localhost:3456` with live editing, syntax highlighting, and a table of contents. Edit in the browser or your text editor — changes sync both ways in real time.

<!-- TODO: Add hero GIF showing single-file mode with live editing -->

## Install

```
npm install -g markdownsync
```

## Usage

Open a single file:

```
mdsync README.md
```

Serve a directory of markdown files as a browsable workspace:

```
mdsync ./docs
```

Build a static HTML site from markdown:

```
mdsync build ./docs --out ./site
```

<!-- TODO: Add screenshot of directory mode with card grid -->

## Features

**Live editing** — Double-click any section to edit with a TipTap rich text editor. Changes save back to the file on disk.

**Two-way sync** — Edit in VS Code, see it update in the browser. Edit in the browser, see it update on disk. File watching handles the rest.

**Syntax highlighting** — Code blocks rendered with Shiki. Looks good out of the box.

**Dark and light themes** — Toggle between them. Defaults to dark.

**Table of contents** — Auto-generated sidebar from your heading structure. Click to navigate.

**Search** — `Cmd+K` to search across content. Works in both single-file and directory mode.

**Zero config** — No `config.yml`, no `docs.json`, no theme files. Point it at markdown and go.

## Directory Mode

Pass a directory instead of a file to serve your entire docs folder:

```
mdsync ./docs
```

This gives you:

- A card grid of all markdown files
- Full-text search across documents
- File management (create, rename, delete)
- The same editing and sync features as single-file mode

Good for documentation workspaces, knowledge bases, or reviewing a batch of AI-generated markdown files.

<!-- TODO: Add screenshot of directory mode search -->

## Static Build

Generate a complete static site from a folder of markdown files:

```
mdsync build ./docs --out ./site
```

Produces self-contained HTML with all styles and scripts inlined. Deploy to any static host — GitHub Pages, Netlify, Vercel, S3, wherever.

No build step configuration. No theme to choose. No plugins to install.

```
mdsync build ./docs --out ./site && netlify deploy --dir ./site --prod
```

## CLI Reference

```
mdsync <file-or-directory>       Serve markdown in the browser
mdsync build <dir> --out <dir>   Generate a static site
mdsync mcp                       Start MCP server
```

### Options

```
--port, -p <number>   Port to serve on (default: 3456)
--light               Start in light theme
--no-edit             Disable browser editing
--no-open             Don't auto-open the browser
```

### Examples

```
# Serve on a custom port
mdsync README.md --port 8080

# Read-only mode for presentations
mdsync ./slides --no-edit

# Light theme, no auto-open
mdsync ./docs --light --no-open

# Build docs to a directory
mdsync build ./docs --out ./public
```

## MCP Integration

mdsync includes a Model Context Protocol server for AI tool integration:

```
mdsync mcp
```

This exposes your markdown files as MCP resources, letting AI assistants read and edit documents through the standard MCP interface.

## Links

- Website: [mdsync.dev](https://mdsync.dev)
- Repository: [github.com/taw0002/mdsync](https://github.com/taw0002/mdsync)
- npm: [markdownsync](https://www.npmjs.com/package/markdownsync)

## License

MIT
