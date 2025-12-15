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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
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

// 태그에 data-line 속성 주입 (멀티라인 지원 개선)
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

        // 여는 태그 찾기
        const tagMatch = line.match(/<([a-zA-Z][a-zA-Z0-9]*)/);
        if (tagMatch) {
            const tagName = tagMatch[1];

            // 제외할 태그가 아니면 속성 주입 (닫는 태그 위치와 상관없이)
            if (!excludedTags.includes(tagName.toLowerCase())) {
                const tagStart = line.indexOf('<' + tagName);

                // 태그명 뒤에 공백이나 >가 오는지 확인하여 정확한 태그 매칭
                if (tagStart !== -1) {
                    const charAfterTag = line.charAt(tagStart + 1 + tagName.length);
                    if (charAfterTag === ' ' || charAfterTag === '>' || charAfterTag === '\t' || charAfterTag === '\n' || charAfterTag === '') {
                        // 태그명 바로 뒤에 data-line 삽입
                        const insertPos = tagStart + 1 + tagName.length;
                        line = line.substring(0, insertPos) + ` data-line="${lineNumber}"` + line.substring(insertPos);
                    }
                }
            }
        }
        result.push(line);
    }

    return result.join('\n');
}

// 닫는 태그 위치 찾기 (네스팅 고려)
function findClosingTagLocation(lines, startLineIndex, tagName) {
    let depth = 0;

    let currentLineIndex = startLineIndex;
    let scanPos = lines[startLineIndex].indexOf('<' + tagName);

    if (scanPos === -1) {
        return null;
    }

    while (currentLineIndex < lines.length) {
        const line = lines[currentLineIndex];
        const textToScan = line;

        // 정규식으로 태그 탐색 (g 플래그 사용)
        const regex = new RegExp(`<\/?${tagName}\\b`, 'gi');
        let match;

        regex.lastIndex = (currentLineIndex === startLineIndex) ? scanPos : 0;

        while ((match = regex.exec(textToScan)) !== null) {
            if (match[0].toLowerCase().startsWith('</')) {
                depth--;
                if (depth === 0) {
                    return { lineIndex: currentLineIndex, index: match.index };
                }
            } else {
                depth++;
            }
        }

        currentLineIndex++;
    }

    return null;
}

// 에디터 관련 속성 제거 (저장 시 오염 방지)
function removeEditorAttributes(content) {
    if (!content) return content;
    return content
        .replace(/\s*data-line="[^"]*"/g, '')
        .replace(/\s*contenteditable="[^"]*"/g, '');
}

// 멀티라인 컨텐츠 교체
function replaceMultiLineElement(lines, startLineIndex, newContent) {
    const line = lines[startLineIndex];
    // 태그명 추출
    const tagMatch = line.match(/<([a-zA-Z][a-zA-Z0-9]*)/);
    if (!tagMatch) return { lines, replacedLines: null };

    const tagName = tagMatch[1];

    // 닫는 태그 위치 찾기
    const closingLoc = findClosingTagLocation(lines, startLineIndex, tagName);

    if (!closingLoc) {
        console.log('[DEBUG] Closing tag not found');
        return { lines, replacedLines: null };
    }

    // 시작 태그의 끝(>) 위치 찾기
    const openTagEnd = lines[startLineIndex].indexOf('>');
    if (openTagEnd === -1) return { lines, replacedLines: null };

    // 원본 라인들 백업 (Undo용)
    const originalLines = lines.slice(startLineIndex, closingLoc.lineIndex + 1);

    if (startLineIndex === closingLoc.lineIndex) {
        // 같은 라인인 경우
        const before = lines[startLineIndex].substring(0, openTagEnd + 1);
        const after = lines[startLineIndex].substring(closingLoc.index);
        lines[startLineIndex] = before + newContent + after;
    } else {
        // 다른 라인인 경우
        const before = lines[startLineIndex].substring(0, openTagEnd + 1);
        const after = lines[closingLoc.lineIndex].substring(closingLoc.index); // 닫는 태그 시작 부분

        // 시작 라인에 모든 내용을 합침
        lines[startLineIndex] = before + newContent + after;

        // 나머지 라인들은 비움
        for (let i = startLineIndex + 1; i <= closingLoc.lineIndex; i++) {
            lines[i] = '';
        }
    }

    return { lines, replacedLines: originalLines };
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
    console.log('[DEBUG] POST /save', { filename, line_number });

    if (!filename || !line_number || content === undefined) {
        return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
    }

    const filePath = path.join(PUBLIC_DIR, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    }

    try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        let lines = fileContent.split('\n');
        const lineIndex = parseInt(line_number) - 1;

        if (lineIndex < 0 || lineIndex >= lines.length) {
            return res.status(400).json({ error: '잘못된 라인 번호입니다.' });
        }

        // 백업 생성
        const fileBasename = path.basename(filename, '.html');
        const backupFileDir = path.join(BACKUP_DIR, fileBasename);
        ensureDir(backupFileDir);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(backupFileDir, `${timestamp}.html`);
        fs.writeFileSync(backupPath, fileContent, 'utf-8');

        // 컨텐츠 정화 (에디터 속성 제거)
        const sanitizedContent = removeEditorAttributes(content);

        // 컨텐츠 교체
        const result = replaceMultiLineElement(lines, lineIndex, sanitizedContent);
        lines = result.lines;

        // Undo 히스토리 저장
        if (result.replacedLines) {
            if (!req.session.history) { req.session.history = []; }
            if (req.session.history.length >= 20) { req.session.history.shift(); }

            // 멀티라인 복원을 위해 라인 배열 전체를 저장
            req.session.history.push({
                filename,
                startLineIndex: lineIndex,
                originalLines: result.replacedLines
            });
        }

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
        // 현재 파일도 백업
        const currentContent = fs.readFileSync(filePath, 'utf-8');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const preRestoreBackup = path.join(BACKUP_DIR, fileBasename, `${timestamp}_pre-restore.html`);
        ensureDir(path.join(BACKUP_DIR, fileBasename));
        fs.writeFileSync(preRestoreBackup, currentContent, 'utf-8');

        // 복원
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

// Undo API (세션 기반)
app.post('/undo', (req, res) => {
    if (!req.session.history || req.session.history.length === 0) {
        return res.status(400).json({ error: '되돌릴 기록이 없습니다.' });
    }

    const lastAction = req.session.history.pop();
    const filePath = path.join(PUBLIC_DIR, lastAction.filename);

    try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        let lines = fileContent.split('\n');

        // 멀티라인 복원
        if (lastAction.originalLines) {
            const startLine = lastAction.startLineIndex;
            const originalLines = lastAction.originalLines;

            for (let i = 0; i < originalLines.length; i++) {
                if (startLine + i < lines.length) {
                    lines[startLine + i] = originalLines[i];
                }
            }
        } else if (lastAction.originalLine) { // 하위 호환
            lines[lastAction.lineIndex] = lastAction.originalLine;
        }

        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

        res.json({
            success: true,
            line_number: (lastAction.startLineIndex || lastAction.lineIndex) + 1,
            content: lines[(lastAction.startLineIndex || lastAction.lineIndex)] // 대략적 내용 반환
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
