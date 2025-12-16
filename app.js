const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const beautify = require('js-beautify').html;

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

// 파일 경로를 고유한 백업 폴더명으로 변환
// 예: test.html -> test, a/test.html -> a__test
function getBackupFolderName(filename) {
    // .html 확장자 제거
    const withoutExt = filename.replace(/\.html$/i, '');
    // 경로 구분자(/ 또는 \)를 __로 변환
    return withoutExt.replace(/[\/\\]/g, '__');
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

    // 기본 들여쓰기 레벨 파악
    const baseIndentMatch = lines[startLineIndex].match(/^\s*/);
    const baseIndent = baseIndentMatch ? baseIndentMatch[0] : '';

    // 전체 태그 문자열 재구성
    let before, after;

    if (startLineIndex === closingLoc.lineIndex) {
        before = lines[startLineIndex].substring(0, openTagEnd + 1);
        after = lines[startLineIndex].substring(closingLoc.index);
    } else {
        before = lines[startLineIndex].substring(0, openTagEnd + 1);
        after = lines[closingLoc.lineIndex].substring(closingLoc.index);
    }

    // 태그 전체를 합쳐서 Beautify 적용
    // 태그 래퍼(before, after)를 포함시킴으로써 js-beautify가 적절한 들여쓰기를 할 수 있도록 함.
    const fullTagString = before + newContent + after;

    console.log('[DEBUG] Before beautify:', fullTagString);

    // 공백 누적 방지를 위해 입력 문자열의 앞뒤 공백 제거 후 포매팅 (Trim)
    const cleanTagString = fullTagString.trim();

    const formattedContent = beautify(cleanTagString, {
        indent_size: 4,
        indent_char: ' ',
        max_preserve_newlines: 0,
        preserve_newlines: false,
        indent_scripts: 'normal',
        wrap_line_length: 0,
        unformatted: []
    });

    // 들여쓰기 보정: 모든 라인에 baseIndent 추가
    const indentedContent = formattedContent.split('\n').map((l, index) => {
        return (l.trim().length > 0) ? baseIndent + l : l;
    }).join('\n');

    console.log('[DEBUG] After beautify:\n', indentedContent);

    // 라인 교체
    // indentedContent는 여러 줄 텍스트임.
    lines[startLineIndex] = indentedContent;

    // 나머지 라인들은 삭제 (splice 사용)
    let deleteCount = 0;
    if (startLineIndex === closingLoc.lineIndex) {
        deleteCount = 0;
    } else {
        deleteCount = closingLoc.lineIndex - startLineIndex;
    }

    if (deleteCount > 0) {
        lines.splice(startLineIndex + 1, deleteCount);
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

        // 백업 생성 (일별 스냅샷 + Diff 방식)
        const backupFolderName = getBackupFolderName(filename);
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const backupFileDir = path.join(BACKUP_DIR, backupFolderName, today);
        ensureDir(backupFileDir);

        const firstBackupPath = path.join(backupFileDir, '00_first.html');
        const lastBackupPath = path.join(backupFileDir, 'last.html');
        let backupPath;

        // 그날 첫 백업인지 확인
        if (!fs.existsSync(firstBackupPath)) {
            // 첫 수정: 원본 전체 파일 저장
            fs.writeFileSync(firstBackupPath, fileContent, 'utf-8');
            fs.writeFileSync(lastBackupPath, fileContent, 'utf-8');
            backupPath = firstBackupPath;
        } else {
            // 중간 수정: Diff만 저장 (before + after)
            const existingDiffs = fs.readdirSync(backupFileDir)
                .filter(f => f.match(/^\d{2}_diff\.json$/))
                .sort();
            const nextNum = String(existingDiffs.length + 1).padStart(2, '0');
            const diffPath = path.join(backupFileDir, `${nextNum}_diff.json`);

            // 변경 전 내용 저장 (복원용)
            const beforeContent = lines[lineIndex];

            // 변경 후 내용을 미리 계산 (복원용)
            const sanitizedForDiff = removeEditorAttributes(content);
            const tempLines = [...lines];
            const tempResult = replaceMultiLineElement(tempLines, lineIndex, sanitizedForDiff);
            const afterContent = tempResult.lines[lineIndex];

            const timestamp = new Date().toISOString();
            const diffData = {
                timestamp,
                lineNumber: parseInt(line_number),
                before: beforeContent,
                after: afterContent
            };
            fs.writeFileSync(diffPath, JSON.stringify(diffData, null, 2), 'utf-8');
            backupPath = diffPath;
        }

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
        const newContent = lines.join('\n');
        fs.writeFileSync(filePath, newContent, 'utf-8');
        console.log('[DEBUG] File saved successfully');

        // last.html 업데이트 (항상 최신 상태 유지)
        fs.writeFileSync(lastBackupPath, newContent, 'utf-8');

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

// 백업 목록 조회 API (일별 폴더 구조 지원)
app.get('/backups', (req, res) => {
    const { filename } = req.query;

    if (!filename) {
        return res.status(400).json({ error: '파일명이 필요합니다.' });
    }

    const backupFolderName = getBackupFolderName(filename);
    const backupFileDir = path.join(BACKUP_DIR, backupFolderName);

    if (!fs.existsSync(backupFileDir)) {
        return res.json({ backups: [] });
    }

    const backups = [];
    const dateFolders = fs.readdirSync(backupFileDir)
        .filter(f => fs.statSync(path.join(backupFileDir, f)).isDirectory())
        .sort((a, b) => b.localeCompare(a)); // 최신 날짜 먼저

    for (const dateFolder of dateFolders) {
        const dayDir = path.join(backupFileDir, dateFolder);
        const files = fs.readdirSync(dayDir);

        // 해당 날짜의 파일들 추가
        for (const file of files) {
            const filePath = path.join(dayDir, file);
            const stat = fs.statSync(filePath);

            backups.push({
                name: `${dateFolder}/${file}`,
                date: dateFolder,
                type: file.endsWith('.html') ? 'snapshot' : 'diff',
                mtime: stat.mtime
            });
        }
    }

    // 날짜별로 그룹핑된 형태로 반환
    res.json({ backups });
});

// 복원 API (일별 폴더 구조 + Diff 순차 복원 지원)
app.post('/restore', (req, res) => {
    const { filename, backupFile } = req.body;

    if (!filename || !backupFile) {
        return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
    }

    const backupFolderName = getBackupFolderName(filename);
    // backupFile은 "YYYY-MM-DD/파일명" 형식
    const backupPath = path.join(BACKUP_DIR, backupFolderName, backupFile);
    const filePath = path.join(PUBLIC_DIR, filename);

    if (!fs.existsSync(backupPath)) {
        return res.status(404).json({ error: '백업 파일을 찾을 수 없습니다.' });
    }

    try {
        // 현재 파일도 백업 (복원 전 상태 저장)
        const currentContent = fs.readFileSync(filePath, 'utf-8');
        const today = new Date().toISOString().split('T')[0];
        const todayBackupDir = path.join(BACKUP_DIR, backupFolderName, today);
        ensureDir(todayBackupDir);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const preRestoreBackup = path.join(todayBackupDir, `${timestamp}_pre-restore.html`);
        fs.writeFileSync(preRestoreBackup, currentContent, 'utf-8');

        let restoredContent;

        if (backupFile.endsWith('.json')) {
            // Diff 파일로 복원: 00_first.html + diff 순차 적용
            const parts = backupFile.split('/');
            const dateFolder = parts[0];
            const targetDiff = parts[1]; // 예: "02_diff.json"
            const targetNum = parseInt(targetDiff.split('_')[0]); // 예: 2

            const dayDir = path.join(BACKUP_DIR, backupFolderName, dateFolder);
            const firstPath = path.join(dayDir, '00_first.html');

            if (!fs.existsSync(firstPath)) {
                return res.status(400).json({ error: '원본 파일(00_first.html)이 없어 diff 복원이 불가능합니다.' });
            }

            // 00_first.html 로드
            restoredContent = fs.readFileSync(firstPath, 'utf-8');

            // diff 파일들을 순차적으로 적용 (01 ~ targetNum)
            for (let i = 1; i <= targetNum; i++) {
                const diffFileName = `${String(i).padStart(2, '0')}_diff.json`;
                const diffFilePath = path.join(dayDir, diffFileName);

                if (fs.existsSync(diffFilePath)) {
                    const diffData = JSON.parse(fs.readFileSync(diffFilePath, 'utf-8'));

                    if (diffData.after) {
                        // before -> after 로 교체
                        const lines = restoredContent.split('\n');
                        const lineIdx = diffData.lineNumber - 1;

                        if (lineIdx >= 0 && lineIdx < lines.length) {
                            lines[lineIdx] = diffData.after;
                            restoredContent = lines.join('\n');
                        }
                    }
                }
            }

            console.log(`[DEBUG] Restored via diff: applied ${targetNum} diffs`);
        } else {
            // 스냅샷 파일로 복원 (00_first.html, last.html 등)
            restoredContent = fs.readFileSync(backupPath, 'utf-8');
        }

        // 복원 적용
        fs.writeFileSync(filePath, restoredContent, 'utf-8');

        res.json({
            success: true,
            message: '복원되었습니다.',
            content: injectLineNumbers(restoredContent)
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
        } else if (lastAction.originalLine) {
            lines[lastAction.lineIndex] = lastAction.originalLine;
        }

        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

        res.json({
            success: true,
            line_number: (lastAction.startLineIndex || lastAction.lineIndex) + 1,
            content: lines[(lastAction.startLineIndex || lastAction.lineIndex)]
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
