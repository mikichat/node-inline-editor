const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const BACKUP_DIR = path.join(__dirname, 'backup');

// 미들웨어 설정
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

app.use(session({
    secret: 'inline-html-editor-secret-key',
    resave: false,
    saveUninitialized: true
}));

// 디렉토리 생성 헬퍼
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

// 태그에 data-line 속성 주입
function injectLineNumbers(content) {
    const lines = content.split('\n');
    const result = [];

    // 편집 제외할 태그 목록 (소문자)
    const excludedTags = ['html', 'head', 'body', 'script', 'style', 'meta', 'link', 'title', '!doctype'];

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        const lineNumber = i + 1;

        // 이미 data-line이 있으면 건너뛰기
        if (line.includes('data-line=')) {
            result.push(line);
            continue;
        }

        // 여는 태그 찾기: < 로 시작하고 닫는 태그(/), 주석(!), 선언(?) 제외
        const tagMatch = line.match(/<([a-zA-Z][a-zA-Z0-9]*)/);
        if (tagMatch) {
            const tagName = tagMatch[1];

            // 제외할 태그가 아니면, 그리고 한 줄 내에 닫는 태그(또는 다른 태그 시작)가 있어서 내용 편집이 가능한 경우만
            if (!excludedTags.includes(tagName.toLowerCase())) {
                const tagStart = line.indexOf('<' + tagName);
                const tagEnd = line.indexOf('>', tagStart);
                const closeTagStart = line.lastIndexOf('<');

                // 1. 태그가 닫혔는가 (> 가 있는가)
                // 2. 내용이 존재할 수 있는가 (마지막 < 위치가 > 보다 뒤에 있는가)
                // 예: <li>내용</li> -> tagEnd(3) < closeTagStart(6) -> OK
                // 예: <ul> -> tagEnd(3), closeTagStart(0) -> index 0은 <ul...의 시작이므로 tagEnd보다 작음 -> FAIL
                // 예: <br> -> tagEnd(3), closeTagStart(0) -> FAIL
                if (tagEnd !== -1 && closeTagStart > tagEnd) {
                    // 태그명 바로 뒤에 data-line 삽입
                    const insertPos = tagStart + 1 + tagName.length;
                    line = line.substring(0, insertPos) + ` data-line="${lineNumber}"` + line.substring(insertPos);
                }
            }
        }
        result.push(line);
    }

    return result.join('\n');
}

// 안전한 텍스트 교체 (정규식 없이 인덱스 사용)
function replaceTextContent(line, newContent) {
    console.log('[DEBUG] replaceTextContent input:', JSON.stringify(line));
    // 첫 번째 > 위치 (여는 태그 끝)
    const openTagEnd = line.indexOf('>');
    console.log('[DEBUG] openTagEnd:', openTagEnd);
    if (openTagEnd === -1) {
        console.log('[DEBUG] Open tag end not found (-1)');
        return line;
    }

    // 마지막 < 위치 (닫는 태그 시작)
    const closeTagStart = line.lastIndexOf('<');
    console.log('[DEBUG] closeTagStart:', closeTagStart);
    if (closeTagStart === -1 || closeTagStart <= openTagEnd) {
        console.log('[DEBUG] Close tag start not found or before open tag end');
        return line;
    }

    // > 와 < 사이의 텍스트를 새 콘텐츠로 교체
    const before = line.substring(0, openTagEnd + 1);
    const after = line.substring(closeTagStart);

    const result = before + newContent + after;
    console.log('[DEBUG] replaceTextContent result:', JSON.stringify(result));
    return result;
}

// ================================
// 라우트
// ================================

// 메인 목록 페이지
app.get('/', (req, res) => {
    ensureDir(PUBLIC_DIR);

    const files = fs.readdirSync(PUBLIC_DIR)
        .filter(file => file.endsWith('.html'))
        .map(file => ({
            name: file,
            size: fs.statSync(path.join(PUBLIC_DIR, file)).size,
            mtime: fs.statSync(path.join(PUBLIC_DIR, file)).mtime
        }));

    res.render('list', { files });
});

// 에디터 페이지
app.get('/editor', (req, res) => {
    const filename = req.query.file;

    if (!filename) {
        return res.status(400).send('파일명이 필요합니다.');
    }

    const filePath = path.join(PUBLIC_DIR, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).send('파일을 찾을 수 없습니다.');
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const injectedContent = injectLineNumbers(content);

    res.render('editor', {
        filename,
        content: injectedContent,
        originalContent: content
    });
});

// 저장 API
app.post('/save', (req, res) => {
    const { filename, line_number, content } = req.body;
    console.log('[DEBUG] POST /save', { filename, line_number, content });

    if (!filename || !line_number || content === undefined) {
        console.log('[DEBUG] Missing parameters');
        return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
    }

    const filePath = path.join(PUBLIC_DIR, filename);

    if (!fs.existsSync(filePath)) {
        console.log('[DEBUG] File not found:', filePath);
        return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    }

    try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const lines = fileContent.split('\n');
        const lineIndex = parseInt(line_number) - 1;
        console.log(`[DEBUG] Line index: ${lineIndex}, Total lines: ${lines.length}`);

        if (lineIndex < 0 || lineIndex >= lines.length) {
            console.log('[DEBUG] Invalid line index');
            return res.status(400).json({ error: '잘못된 라인 번호입니다.' });
        }

        // 백업 생성
        const fileBasename = path.basename(filename, '.html');
        const backupFileDir = path.join(BACKUP_DIR, fileBasename);
        ensureDir(backupFileDir);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(backupFileDir, `${timestamp}.html`);
        fs.writeFileSync(backupPath, fileContent, 'utf-8');
        console.log('[DEBUG] Backup saved at:', backupPath);

        // 라인 교체
        const originalLine = lines[lineIndex];
        console.log('[DEBUG] Original line:', JSON.stringify(originalLine));

        // Undo를 위한 세션 기록 저장
        if (!req.session.history) {
            req.session.history = [];
        }
        if (req.session.history.length >= 20) {
            req.session.history.shift();
        }
        req.session.history.push({
            filename,
            lineIndex,
            originalLine
        });

        const newLine = replaceTextContent(originalLine, content);
        if (originalLine === newLine) {
            console.log('[DEBUG] WARNING: Line content unchanged!');
        }
        lines[lineIndex] = newLine;

        // 파일 저장
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        console.log('[DEBUG] File saved successfully');

        res.json({
            success: true,
            message: '저장되었습니다.',
            backup: backupPath
        });
    } catch (err) {
        console.error('[DEBUG] Save error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 백업 목록 조회 API
app.get('/backups', (req, res) => {
    const { filename } = req.query;

    if (!filename) {
        return res.status(400).json({ error: '파일명이 필요합니다.' });
    }

    const fileBasename = path.basename(filename, '.html');
    const backupFileDir = path.join(BACKUP_DIR, fileBasename);

    if (!fs.existsSync(backupFileDir)) {
        return res.json({ backups: [] });
    }

    const backups = fs.readdirSync(backupFileDir)
        .filter(file => file.endsWith('.html'))
        .map(file => ({
            name: file,
            timestamp: file.replace('.html', '').replace(/-/g, (m, i) => i < 20 ? (i === 10 ? 'T' : (i === 13 || i === 16 ? ':' : '-')) : m),
            mtime: fs.statSync(path.join(backupFileDir, file)).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime);

    res.json({ backups });
});

// 복원 API
app.post('/restore', (req, res) => {
    const { filename, backupFile } = req.body;

    if (!filename || !backupFile) {
        return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
    }

    const fileBasename = path.basename(filename, '.html');
    const backupPath = path.join(BACKUP_DIR, fileBasename, backupFile);
    const filePath = path.join(PUBLIC_DIR, filename);

    if (!fs.existsSync(backupPath)) {
        return res.status(404).json({ error: '백업 파일을 찾을 수 없습니다.' });
    }

    try {
        // 현재 파일도 백업 (복원 전 상태 보존)
        const currentContent = fs.readFileSync(filePath, 'utf-8');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const preRestoreBackup = path.join(BACKUP_DIR, fileBasename, `${timestamp}_pre-restore.html`);
        ensureDir(path.join(BACKUP_DIR, fileBasename));
        fs.writeFileSync(preRestoreBackup, currentContent, 'utf-8');

        // 백업 파일로 복원
        const backupContent = fs.readFileSync(backupPath, 'utf-8');
        fs.writeFileSync(filePath, backupContent, 'utf-8');

        res.json({
            success: true,
            message: '복원되었습니다.',
            content: injectLineNumbers(backupContent)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Undo API (세션 기반 - 단순 되돌리기)
app.post('/undo', (req, res) => {
    if (!req.session.history || req.session.history.length === 0) {
        return res.status(400).json({ error: '되돌릴 기록이 없습니다.' });
    }

    const lastAction = req.session.history.pop();
    const filePath = path.join(PUBLIC_DIR, lastAction.filename);

    try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const lines = fileContent.split('\n');

        lines[lastAction.lineIndex] = lastAction.originalLine;
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

        res.json({
            success: true,
            line_number: lastAction.lineIndex + 1,
            content: lastAction.originalLine
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 서버 시작
app.listen(PORT, () => {
    console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
    ensureDir(PUBLIC_DIR);
    ensureDir(BACKUP_DIR);
});
