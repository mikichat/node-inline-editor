require('dotenv').config();
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const beautify = require('js-beautify').html;

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = process.env.PUBLIC_DIR
    ? path.resolve(process.env.PUBLIC_DIR)
    : path.join(__dirname, 'public');
const BACKUP_DIR = path.join(__dirname, 'backup');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

// 허용된 확장자 설정 (기본값: html)
const ALLOWED_EXTENSIONS = (process.env.ALLOWED_EXTENSIONS || 'html')
    .split(',')
    .map(ext => ext.trim().toLowerCase())
    .filter(ext => ext.length > 0);

// 로그인 시도 제한 관리 (메모리 저장소)
// IP별 { count, firstAttempt, blockedUntil } 저장
const loginAttempts = new Map();

// 1시간마다 만료된 항목 정리 (메모리 누수 방지)
setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of loginAttempts.entries()) {
        if (data.blockedUntil && data.blockedUntil < now) {
            loginAttempts.delete(ip);
        } else if (!data.blockedUntil && now - data.firstAttempt > 60000) {
            loginAttempts.delete(ip); // 1분 지난 실패 기록 삭제
        }
    }
}, 3600000); // 1시간 주기

// ================================
// 보안 미들웨어 설정
// ================================

// Helmet: HTTP 보안 헤더 설정
app.use(helmet({
    contentSecurityPolicy: false // 인라인 스크립트 허용을 위해 비활성화
}));

// ProxyPass 사용 시 X-Forwarded-For 헤더 신뢰 설정
// (Apache/Nginx 등 리버스 프록시 환경에서 필수)
app.set('trust proxy', 1);

// Rate Limiting: 요청 제한 (DoS 방지)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15분
    max: 200, // 최대 200회 요청
    message: { error: '너무 많은 요청입니다. 잠시 후 다시 시도해주세요.' }
});
app.use(limiter);

// 뷰 엔진 설정
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(PUBLIC_DIR));

// 세션 설정 (보안 강화 및 FileStore 적용)
app.use(session({
    store: new FileStore({
        path: './sessions',
        ttl: 86400, // 1일
        retries: 0
    }),
    secret: process.env.SESSION_SECRET || 'inline-html-editor-secret-key-change-in-production',
    resave: false, // FileStore 사용 시 false 권장
    saveUninitialized: false,
    rolling: true, // 활동 시 세션 만료 시간 갱신
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 600000, // 10분
        sameSite: 'strict'
    }
}));

// 인증 미들웨어
function isAuthenticated(req, res, next) {
    if (req.session.loggedIn) {
        return next();
    }
    res.redirect('/login');
}

// ================================
// 보안 헬퍼 함수
// ================================

/**
 * 경로 트래버설 공격 방지를 위해 파일 경로가 유효한 디렉토리 내에 있는지 확인합니다.
 * @param {string} filename - 검사할 파일명
 * @param {string} [baseDir=PUBLIC_DIR] - 기준 디렉토리
 * @returns {boolean} 안전 여부
 */
function isPathSafe(filename, baseDir = PUBLIC_DIR) {
    if (!filename || typeof filename !== 'string') {
        return false;
    }
    // 널 바이트 공격 방지
    if (filename.includes('\0')) {
        return false;
    }
    const normalized = path.normalize(filename);
    const fullPath = path.join(baseDir, normalized);
    const resolvedBase = path.resolve(baseDir);
    const resolvedPath = path.resolve(fullPath);
    return resolvedPath.startsWith(resolvedBase + path.sep) || resolvedPath === resolvedBase;
}

// 파일명 유효성 검사
function isValidFilename(filename) {
    if (!filename || typeof filename !== 'string') {
        return false;
    }

    // 점유 중인 확장자 확인
    const ext = path.extname(filename).toLowerCase().replace('.', '');
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
        return false;
    }

    // 기본 보안 체크 (특수문자 제한 및 상위 디렉토리 접근 차단)
    return !filename.includes('..') && /^[a-zA-Z0-9가-힣_\-\/\. ]+$/.test(filename);
}

// 확장자 체크 헬퍼
function isAllowedExtension(filename) {
    const ext = path.extname(filename).toLowerCase().replace('.', '');
    return ALLOWED_EXTENSIONS.includes(ext);
}

// 디렉토리 생성 헬퍼
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

// 파일 경로를 고유한 백업 폴더명으로 변환
function getBackupFolderName(filename) {
    // 확장자를 포함한 전체 파일명에서 점(.)을 언더바(_)로 변환
    // 경로 구분자(/ 또는 \)를 __로 변환
    return filename.replace(/\./g, '_').replace(/[\/\\]/g, '__');
}

/**
 * 편집 가능한 태그에 data-line 속성을 주입하여 클라이언트 에디터에서 라인 추적을 가능하게 합니다.
 * @param {string} content - 원본 HTML 내용
 * @returns {string} 속성이 주입된 HTML 내용
 */
function injectLineNumbers(content) {
    const lines = content.split('\n');
    const result = [];

    // 편집 제외할 태그 목록 (소문자)
    // 컨테이너 태그는 내부 요소 편집을 위해 제외
    const excludedTags = [
        'html', 'head', 'body', 'script', 'style', 'meta', 'link', 'title', '!doctype',
        'div', 'span', 'ul', 'ol', 'dl', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup', 'caption',
        'select', 'optgroup', 'datalist', 'fieldset', 'form', 'nav', 'main', 'section',
        'article', 'aside', 'header', 'footer', 'figure', 'details', 'summary', 'br', 'hr'
    ];

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

/**
 * HTML 내 특정 태그의 닫는 태그 위치를 재귀적으로(네스팅 고려) 찾습니다.
 * @param {string[]} lines - 파일 내용 (라인별 배열)
 * @param {number} startLineIndex - 시작 라인 인덱스
 * @param {string} tagName - 찾을 태그명
 * @returns {Object|null} 닫는 태그의 위치 정보 {lineIndex, index}
 */
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

/**
 * 에디터에서 사용된 특수 속성들을 제거하여 저장 시 파일 오염을 방지합니다.
 * @param {string} content - 정화할 HTML 내용
 * @returns {string} 정화된 HTML 내용
 */
function removeEditorAttributes(content) {
    if (!content) return content;
    return content
        .replace(/\s*data-line="[^"]*"/g, '')
        .replace(/\s*contenteditable="[^"]*"/g, '');
}

// 단순 1라인 텍스트 컨텐츠 교체 (태그 구조 유지, 텍스트만 교체)
function replaceSingleLine(lines, lineIndex, newContent) {
    const line = lines[lineIndex];

    // 태그명 추출
    const tagMatch = line.match(/<([a-zA-Z][a-zA-Z0-9]*)/);
    if (!tagMatch) return { lines, originalLine: null };

    const tagName = tagMatch[1];

    // 시작 태그의 끝(>) 위치 찾기
    const openTagEnd = line.indexOf('>');
    if (openTagEnd === -1) return { lines, originalLine: null };

    // 닫는 태그 찾기 (같은 라인 내에서만)
    const closeTagRegex = new RegExp(`</${tagName}>`, 'i');
    const closeTagMatch = line.match(closeTagRegex);

    if (!closeTagMatch) {
        // 닫는 태그가 같은 라인에 없으면 멀티라인 요소
        console.log('[DEBUG] Closing tag not on same line, checking if simple text multiline');

        // findClosingTagLocation 사용하여 닫는 태그 위치 찾기
        const closingLoc = findClosingTagLocation(lines, lineIndex, tagName);
        const endLineIndex = closingLoc ? closingLoc.lineIndex : lineIndex;

        // li, td 태그의 경우 단순 텍스트만 있으면 인라인 편집 허용
        if ((tagName.toLowerCase() === 'li' || tagName.toLowerCase() === 'td') && closingLoc) {
            // 시작 라인부터 끝 라인까지의 전체 내용 추출
            const fullContent = lines.slice(lineIndex, endLineIndex + 1).join('\n');

            // 시작 태그와 닫는 태그 제거하여 내부 내용만 추출
            const contentBetweenTags = fullContent.substring(
                fullContent.indexOf('>') + 1,
                fullContent.lastIndexOf('</' + tagName + '>')
            );

            // 내부에 다른 HTML 태그가 있는지 확인 (br 제외)
            const hasOtherTags = /<(?!br\s*\/?>)[^>]+>/i.test(contentBetweenTags);

            if (!hasOtherTags) {
                // 순수 텍스트 (또는 br만 있음) - 인라인 편집 허용
                console.log('[DEBUG] Simple text multiline detected, allowing inline edit');

                // 원본 라인 백업
                const originalLine = line;

                // 들여쓰기 추출
                const indentMatch = line.match(/^\s*/);
                const indent = indentMatch ? indentMatch[0] : '';

                // 시작 태그 부분 추출
                const before = line.substring(0, openTagEnd + 1);

                // 새 내용에서 에디터 속성 제거
                const cleanedContent = removeEditorAttributes(newContent);

                // 한 줄로 합치기
                const newLine = indent + before + cleanedContent + '</' + tagName + '>';

                // 원본 멀티라인을 단일 라인으로 교체
                lines.splice(lineIndex, endLineIndex - lineIndex + 1, newLine);

                console.log('[DEBUG] Converted multiline to single line:', newLine);

                return { lines, originalLine };
            }
        }

        // 일반 멀티라인 요소 (팝업 에디터 사용)
        console.log('[DEBUG] Complex multiline element, using popup editor');
        return {
            lines,
            originalLine: null,
            isMultiline: true,
            startLineIndex: lineIndex,
            endLineIndex: endLineIndex
        };
    }

    // 원본 라인 백업 (Undo용)
    const originalLine = line;

    // 시작 태그와 닫는 태그 사이의 내용만 교체
    const closeTagIndex = line.indexOf(closeTagMatch[0]);
    const before = line.substring(0, openTagEnd + 1);
    const after = line.substring(closeTagIndex);

    // newContent에서 에디터 속성만 제거 (내부 HTML 태그는 유지)
    const cleanedContent = removeEditorAttributes(newContent);

    // 새 라인 조합
    const newLine = before + cleanedContent + after;

    console.log('[DEBUG] Single line replace:', { before, cleanedContent, after });

    lines[lineIndex] = newLine;

    return { lines, originalLine };
}

// ================================
// 라우트
// ================================

// 로그인 페이지
app.get('/login', (req, res) => {
    if (req.session.loggedIn) {
        return res.redirect('/');
    }
    res.render('login');
});

// 로그인 처리
app.post('/login', (req, res) => {
    const { password } = req.body;
    const ip = req.ip;
    const now = Date.now();

    // 1. 차단 여부 확인
    if (loginAttempts.has(ip)) {
        const data = loginAttempts.get(ip);
        if (data.blockedUntil) {
            if (data.blockedUntil > now) {
                const remainingMinutes = Math.ceil((data.blockedUntil - now) / 60000);
                return res.render('login', {
                    error: `로그인 시도가 너무 많아 접속이 차단되었습니다. ${remainingMinutes}분 후에 다시 시도해주세요.`
                });
            } else {
                // 차단 시간 종료
                loginAttempts.delete(ip);
            }
        }
    }

    if (password === ADMIN_PASSWORD) {
        // 로그인 성공 시 실패 기록 초기화
        loginAttempts.delete(ip);
        req.session.loggedIn = true;
        res.redirect('/');
    } else {
        // 로그인 실패 처리
        let attemptData = loginAttempts.get(ip);

        if (!attemptData) {
            attemptData = { count: 1, firstAttempt: now, blockedUntil: null };
            loginAttempts.set(ip, attemptData);
        } else {
            // 1분(60000ms) 윈도우 체크
            if (now - attemptData.firstAttempt > 60000) {
                // 1분이 지났으면 카운트 리셋
                attemptData.count = 1;
                attemptData.firstAttempt = now;
            } else {
                attemptData.count++;
            }
        }

        // 5회 도달 시 차단
        if (attemptData.count >= 5) {
            attemptData.blockedUntil = now + 3600000; // 1시간 (60분 * 60초 * 1000ms)
            return res.render('login', {
                error: '비밀번호를 5회 연속 잘못 입력하여 1시간 동안 접속이 제한됩니다.'
            });
        }

        const remainingAttempts = 5 - attemptData.count;
        res.render('login', {
            error: `비밀번호가 올바르지 않습니다. (1분 내 남은 시도 횟수: ${remainingAttempts}회)`
        });
    }
});

// 로그아웃
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// 메인 목록 페이지 (인증 필요)
app.get('/', isAuthenticated, (req, res) => {
    ensureDir(PUBLIC_DIR);

    const files = fs.readdirSync(PUBLIC_DIR)
        .filter(file => isAllowedExtension(file))
        .map(file => ({
            name: file,
            size: fs.statSync(path.join(PUBLIC_DIR, file)).size,
            mtime: fs.statSync(path.join(PUBLIC_DIR, file)).mtime
        }));

    res.render('list', { files });
});

// 에디터 페이지
app.get('/editor', isAuthenticated, (req, res) => {
    const filename = req.query.file;

    if (!filename) {
        return res.status(400).send('파일명이 필요합니다.');
    }

    // 보안: Path Traversal 방지 및 확장자 체크
    if (!isPathSafe(filename) || !isAllowedExtension(filename)) {
        return res.status(403).send('접근이 거부되었습니다. 허용되지 않은 파일 형식입니다.');
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

// 소스 조회 API (전체 파일 내용)
app.get('/source', isAuthenticated, (req, res) => {
    const filename = req.query.filename;

    if (!filename) {
        return res.status(400).json({ error: '파일명이 필요합니다.' });
    }

    // 보안: Path Traversal 방지 및 확장자 체크
    if (!isPathSafe(filename) || !isAllowedExtension(filename)) {
        return res.status(403).json({ error: '접근이 거부되었습니다. 허용되지 않은 파일 형식입니다.' });
    }

    const filePath = path.join(PUBLIC_DIR, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ content });
});

// 소스 정렬 API (js-beautify 사용)
app.post('/format-source', isAuthenticated, (req, res) => {
    const { content } = req.body;

    if (content === undefined) {
        return res.status(400).json({ error: '내용이 필요합니다.' });
    }

    try {
        const formattedContent = beautify(content, {
            indent_size: 4,
            indent_char: ' ',
            max_preserve_newlines: 2,
            preserve_newlines: true,
            indent_scripts: 'normal',
            wrap_line_length: 0,
            unformatted: ['a', 'span', 'strong', 'em', 'b', 'i', 'u', 'br']
        });

        res.json({ success: true, formattedContent });
    } catch (err) {
        console.error('[DEBUG] Format error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 라인 정보 조회 API (더블클릭으로 멀티라인 에디터 열기용)
app.get('/line-info', isAuthenticated, (req, res) => {
    const { filename, line } = req.query;

    if (!filename || !line) {
        return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
    }

    // 보안: Path Traversal 방지 및 확장자 체크
    if (!isPathSafe(filename) || !isAllowedExtension(filename)) {
        return res.status(403).json({ error: '접근이 거부되었습니다. 허용되지 않은 파일 형식입니다.' });
    }

    const filePath = path.join(PUBLIC_DIR, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    }

    try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const lines = fileContent.split('\n');
        const lineIndex = parseInt(line) - 1;

        if (lineIndex < 0 || lineIndex >= lines.length) {
            return res.status(400).json({ error: '잘못된 라인 번호입니다.' });
        }

        const currentLine = lines[lineIndex];

        // 태그명 추출
        const tagMatch = currentLine.match(/<([a-zA-Z][a-zA-Z0-9]*)/);
        if (!tagMatch) {
            return res.json({ success: false, error: '태그를 찾을 수 없습니다.' });
        }

        const tagName = tagMatch[1];

        // 닫는 태그 위치 찾기
        const closingLoc = findClosingTagLocation(lines, lineIndex, tagName);
        const endLineIndex = closingLoc ? closingLoc.lineIndex : lineIndex;

        // 해당 범위의 내용 추출
        const content = lines.slice(lineIndex, endLineIndex + 1).join('\n');

        res.json({
            success: true,
            startLine: lineIndex + 1,
            endLine: endLineIndex + 1,
            content
        });
    } catch (err) {
        console.error('[DEBUG] Line info error:', err);
        res.status(500).json({ error: err.message });
    }
});
app.post('/save-source', isAuthenticated, (req, res) => {
    const { filename, content } = req.body;

    if (!filename || content === undefined) {
        return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
    }

    // 보안: Path Traversal 방지 및 확장자 체크
    if (!isPathSafe(filename) || !isAllowedExtension(filename)) {
        return res.status(403).json({ error: '접근이 거부되었습니다. 허용되지 않은 파일 형식입니다.' });
    }

    const filePath = path.join(PUBLIC_DIR, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    }

    try {
        // 백업 생성
        const backupFolderName = getBackupFolderName(filename);
        const today = new Date().toISOString().split('T')[0];
        const backupFileDir = path.join(BACKUP_DIR, backupFolderName, today);
        ensureDir(backupFileDir);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const ext = path.extname(filename);
        const backupPath = path.join(backupFileDir, `${timestamp}_source-edit${ext}`);

        // 현재 파일 백업
        const currentContent = fs.readFileSync(filePath, 'utf-8');
        fs.writeFileSync(backupPath, currentContent, 'utf-8');

        // 새 내용 저장
        fs.writeFileSync(filePath, content, 'utf-8');

        // 백업 업데이트 (항상 최신 상태 유지)
        const lastBackupPath = path.join(backupFileDir, `last${ext}`);
        fs.writeFileSync(lastBackupPath, content, 'utf-8');

        console.log('[DEBUG] Source saved successfully');
        res.json({ success: true, message: '소스가 저장되었습니다.' });
    } catch (err) {
        console.error('[DEBUG] Save source error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 멀티라인 저장 API (특정 라인 범위 교체)
app.post('/save-multiline', isAuthenticated, (req, res) => {
    const { filename, startLine, endLine, content } = req.body;

    if (!filename || !startLine || !endLine || content === undefined) {
        return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
    }

    // 보안: Path Traversal 방지 및 확장자 체크
    if (!isPathSafe(filename) || !isAllowedExtension(filename)) {
        return res.status(403).json({ error: '접근이 거부되었습니다. 허용되지 않은 파일 형식입니다.' });
    }

    const filePath = path.join(PUBLIC_DIR, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    }

    try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        let lines = fileContent.split('\n');

        const startIdx = parseInt(startLine) - 1;
        const endIdx = parseInt(endLine) - 1;

        if (startIdx < 0 || endIdx >= lines.length || startIdx > endIdx) {
            return res.status(400).json({ error: '잘못된 라인 범위입니다.' });
        }

        // 백업 생성
        const backupFolderName = getBackupFolderName(filename);
        const today = new Date().toISOString().split('T')[0];
        const backupFileDir = path.join(BACKUP_DIR, backupFolderName, today);
        ensureDir(backupFileDir);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const ext = path.extname(filename);
        const backupPath = path.join(backupFileDir, `${timestamp}_multiline-edit${ext}`);
        fs.writeFileSync(backupPath, fileContent, 'utf-8');

        // 에디터 속성 제거
        const sanitizedContent = removeEditorAttributes(content);

        // 지정된 라인 범위를 새 내용으로 교체
        const newContentLines = sanitizedContent.split('\n');

        // 원본 라인들 백업 (Undo용)
        const originalLines = lines.slice(startIdx, endIdx + 1);

        // 기존 라인들 제거하고 새 라인들 삽입
        lines.splice(startIdx, endIdx - startIdx + 1, ...newContentLines);

        // 파일 저장
        const newFileContent = lines.join('\n');
        fs.writeFileSync(filePath, newFileContent, 'utf-8');

        // 백업 업데이트
        const lastBackupPath = path.join(backupFileDir, `last${ext}`);
        fs.writeFileSync(lastBackupPath, newFileContent, 'utf-8');

        // Undo 히스토리 저장 (멀티라인 복원용)
        if (!req.session.history) { req.session.history = []; }
        if (req.session.history.length >= 20) { req.session.history.shift(); }

        req.session.history.push({
            filename,
            isMultiline: true,
            startLineIndex: startIdx,
            endLineIndex: endIdx,
            originalLines: originalLines,
            newLineCount: newContentLines.length
        });

        console.log('[DEBUG] Multiline saved successfully');
        res.json({ success: true, message: '멀티라인 저장이 완료되었습니다.' });
    } catch (err) {
        console.error('[DEBUG] Save multiline error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 저장 API
app.post('/save', isAuthenticated, (req, res) => {
    const { filename, line_number, content } = req.body;
    console.log('[DEBUG] POST /save', { filename, line_number });

    if (!filename || !line_number || content === undefined) {
        return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
    }

    // 보안: Path Traversal 방지 및 확장자 체크
    if (!isPathSafe(filename) || !isAllowedExtension(filename)) {
        return res.status(403).json({ error: '접근이 거부되었습니다. 허용되지 않은 파일 형식입니다.' });
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

        const ext = path.extname(filename);
        const firstBackupPath = path.join(backupFileDir, `00_first${ext}`);
        const lastBackupPath = path.join(backupFileDir, `last${ext}`);
        let backupPath;

        // 그날 첫 백업인지 확인
        if (!fs.existsSync(firstBackupPath)) {
            // 첫 수정: 원본 전체 파일 저장
            fs.writeFileSync(firstBackupPath, fileContent, 'utf-8');
            fs.writeFileSync(lastBackupPath, fileContent, 'utf-8');
            backupPath = firstBackupPath;
        } else {
            // 변경 후 내용을 미리 계산 (복원용 및 멀티라인 체크)
            const sanitizedForDiff = removeEditorAttributes(content);
            const tempLines = [...lines];
            const tempResult = replaceSingleLine(tempLines, lineIndex, sanitizedForDiff);

            // 멀티라인 요소 체크 - 팝업 에디터로 전환
            if (tempResult.originalLine === null && tempResult.isMultiline) {
                const startLine = tempResult.startLineIndex + 1;
                const endLine = tempResult.endLineIndex + 1;
                const originalContent = lines.slice(tempResult.startLineIndex, tempResult.endLineIndex + 1).join('\n');

                return res.json({
                    success: false,
                    isMultiline: true,
                    startLine,
                    endLine,
                    originalContent
                });
            } else if (tempResult.originalLine === null) {
                return res.json({
                    success: false,
                    error: '편집할 수 없는 요소입니다.'
                });
            }

            // 무결성 검사 (기존 백업 체인과 현재 파일 비교)
            const expectedContent = reconstructContent(backupFolderName, today, ext);
            let integrityCheck = false;

            // reconstructContent가 null이면 (00_first 없음) 무조건 실패 처리 -> 스냅샷 생성
            // fileContent는 위에서 readFileSync로 읽은 현재 파일 내용
            if (expectedContent && expectedContent === fileContent) {
                integrityCheck = true;
            } else {
                console.log('[INFO] Integrity check failed. Creating snapshot backup instead of diff.');
            }

            if (integrityCheck) {
                // 중간 수정: Diff만 저장 (before + after)
                const existingDiffs = fs.readdirSync(backupFileDir)
                    .filter(f => f.match(/^\d{2}_diff\.json$/))
                    .sort();
                const nextNum = String(existingDiffs.length + 1).padStart(2, '0');
                const diffPath = path.join(backupFileDir, `${nextNum}_diff.json`);

                // 변경 전 내용 저장 (복원용)
                const beforeContent = lines[lineIndex];
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
            } else {
                // 스냅샷 생성 (체인 깨짐 또는 멀티라인/외부 수정 발생 시)
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const snapshotPath = path.join(backupFileDir, `${timestamp}_auto-snapshot${ext}`);
                fs.writeFileSync(snapshotPath, fileContent, 'utf-8');
                backupPath = snapshotPath;
            }
        }

        // 컨텐츠 정화 (에디터 속성 제거)
        const sanitizedContent = removeEditorAttributes(content);

        // 컨텐츠 교체
        const result = replaceSingleLine(lines, lineIndex, sanitizedContent);

        // 멀티라인 요소는 팝업 에디터로 전환
        if (result.originalLine === null && result.isMultiline) {
            // 멀티라인 요소의 원본 내용 추출
            const startLine = result.startLineIndex + 1;
            const endLine = result.endLineIndex + 1;
            const originalContent = lines.slice(result.startLineIndex, result.endLineIndex + 1).join('\n');

            return res.json({
                success: false,
                isMultiline: true,
                startLine,
                endLine,
                originalContent
            });
        } else if (result.originalLine === null) {
            return res.json({
                success: false,
                error: '편집할 수 없는 요소입니다.'
            });
        }

        lines = result.lines;

        // Undo 히스토리 저장
        if (!req.session.history) { req.session.history = []; }
        if (req.session.history.length >= 20) { req.session.history.shift(); }

        // 단일 라인 복원을 위해 원본 라인 저장
        req.session.history.push({
            filename,
            lineIndex: lineIndex,
            originalLine: result.originalLine
        });

        // 파일 저장
        const newContent = lines.join('\n');
        fs.writeFileSync(filePath, newContent, 'utf-8');
        console.log('[DEBUG] File saved successfully');

        // 백업 업데이트 (항상 최신 상태 유지)
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
app.get('/backups', isAuthenticated, (req, res) => {
    const { filename } = req.query;

    if (!filename) {
        return res.status(400).json({ error: '파일명이 필요합니다.' });
    }

    // 보안: Path Traversal 방지 및 확장자 체크
    if (!isPathSafe(filename) || !isAllowedExtension(filename)) {
        return res.status(403).json({ error: '접근이 거부되었습니다. 허용되지 않은 파일 형식입니다.' });
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
                type: file.endsWith('.json') ? 'diff' : 'snapshot',
                mtime: stat.mtime
            });
        }
    }

    // 최신순 정렬 (수정 시간 기준)
    backups.sort((a, b) => {
        const timeA = new Date(a.mtime).getTime();
        const timeB = new Date(b.mtime).getTime();
        return timeB - timeA;
    });

    // 날짜별로 그룹핑된 형태로 반환
    res.json({ backups });
});

// 복원 API (일별 폴더 구조 + Diff 순차 복원 지원)
app.post('/restore', isAuthenticated, (req, res) => {
    const { filename, backupFile } = req.body;
    console.log(`[RESTORE] Requested: filename=${filename}, backupFile=${backupFile}`);

    if (!filename || !backupFile) {
        console.error('[RESTORE] Error: Missing parameters');
        return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
    }

    // 보안: Path Traversal 방지 및 확장자 체크
    if (!isPathSafe(filename) || !isAllowedExtension(filename)) {
        console.error(`[RESTORE] Security Error: Unsafe path or extension (${filename})`);
        return res.status(403).json({ error: '접근이 거부되었습니다. 허용되지 않은 파일 형식입니다.' });
    }

    const backupFolderName = getBackupFolderName(filename);
    // backupFile은 "YYYY-MM-DD/파일명" 형식
    const backupPath = path.join(BACKUP_DIR, backupFolderName, backupFile);
    const filePath = path.join(PUBLIC_DIR, filename);

    console.log(`[RESTORE] Backup Path: ${backupPath}`);
    console.log(`[RESTORE] Target File: ${filePath}`);

    if (!fs.existsSync(backupPath)) {
        console.error(`[RESTORE] Error: Backup file not found at ${backupPath}`);
        return res.status(404).json({ error: '백업 파일을 찾을 수 없습니다.' });
    }

    try {
        // 현재 파일도 백업 (복원 전 상태 저장)
        const currentContent = fs.readFileSync(filePath, 'utf-8');
        const today = new Date().toISOString().split('T')[0];
        const todayBackupDir = path.join(BACKUP_DIR, backupFolderName, today);
        ensureDir(todayBackupDir);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const ext = path.extname(filename);
        const preRestoreBackup = path.join(todayBackupDir, `${timestamp}_pre-restore${ext}`);
        fs.writeFileSync(preRestoreBackup, currentContent, 'utf-8');
        console.log(`[RESTORE] Pre-restore backup saved: ${preRestoreBackup}`);

        let restoredContent;

        if (backupFile.endsWith('.json')) {
            // Diff 파일로 복원: 00_first + diff 순차 적용
            const parts = backupFile.split('/');
            const dateFolder = parts[0];
            const targetDiff = parts[1]; // 예: "02_diff.json"
            const targetNum = parseInt(targetDiff.split('_')[0]); // 예: 2

            restoredContent = reconstructContent(backupFolderName, dateFolder, ext, targetNum);
            if (restoredContent === null) {
                return res.status(400).json({ error: `원본 파일(00_first${ext})이 없어 diff 복원이 불가능합니다.` });
            }
        } else {
            // 스냅샷 파일로 복원 (00_first, last 등)
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

// 백업 내용 조회 API (미리보기용)
app.get('/backup-content', isAuthenticated, (req, res) => {
    const { filename, backupFile } = req.query;

    if (!filename || !backupFile) {
        return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
    }

    // 보안: Path Traversal 방지 및 확장자 체크
    if (!isPathSafe(filename) || !isAllowedExtension(filename)) {
        return res.status(403).json({ error: '접근이 거부되었습니다. 허용되지 않은 파일 형식입니다.' });
    }

    const backupFolderName = getBackupFolderName(filename);
    const backupPath = path.join(BACKUP_DIR, backupFolderName, backupFile);

    if (!fs.existsSync(backupPath)) {
        return res.status(404).json({ error: '백업 파일을 찾을 수 없습니다.' });
    }

    try {
        if (backupFile.endsWith('.json')) {
            // Diff 파일 정보 반환
            const diffData = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
            res.json({
                success: true,
                type: 'diff',
                data: diffData
            });
        } else {
            // 스냅샷 파일 내용 반환
            const content = fs.readFileSync(backupPath, 'utf-8');
            res.json({
                success: true,
                type: 'snapshot',
                content
            });
        }
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
        if (lastAction.isMultiline && lastAction.originalLines) {
            const startIdx = lastAction.startLineIndex;
            const newLineCount = lastAction.newLineCount || 1;

            // 현재 삽입된 라인들 제거하고 원본 라인들 복원
            lines.splice(startIdx, newLineCount, ...lastAction.originalLines);

            fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

            // 복원된 내용의 첫 번째 라인 반환 (DOM 업데이트용)
            res.json({
                success: true,
                isMultiline: true,
                startLine: startIdx + 1,
                restoredContent: lastAction.originalLines.join('\n')
            });
        }
        // 단일 라인 복원
        else if (lastAction.originalLine !== undefined) {
            lines[lastAction.lineIndex] = lastAction.originalLine;

            fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

            res.json({
                success: true,
                line_number: lastAction.lineIndex + 1,
                content: lines[lastAction.lineIndex]
            });
        } else {
            res.status(400).json({ error: '잘못된 되돌리기 데이터입니다.' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Helper to verify integrity and reconstruct content
function reconstructContent(backupFolderName, dateFolder, ext, targetNum = Infinity) {
    const dayDir = path.join(BACKUP_DIR, backupFolderName, dateFolder);
    const firstPath = path.join(dayDir, `00_first${ext}`);

    // If 00_first doesn't exist, we can't reconstruct
    if (!fs.existsSync(firstPath)) return null;

    let content = fs.readFileSync(firstPath, 'utf-8');
    const files = fs.readdirSync(dayDir);
    const diffFiles = files.filter(f => f.match(/^\d{2}_diff\.json$/)).sort();

    for (const diffFile of diffFiles) {
        const num = parseInt(diffFile.split('_')[0]);
        if (num > targetNum) break;

        const diffPath = path.join(dayDir, diffFile);
        try {
            const diffData = JSON.parse(fs.readFileSync(diffPath, 'utf-8'));
            if (diffData.after) {
                const lines = content.split('\n');
                const lineIdx = diffData.lineNumber - 1;
                if (lineIdx >= 0 && lineIdx < lines.length) {
                    lines[lineIdx] = diffData.after;
                    content = lines.join('\n');
                }
            }
        } catch (e) {
            console.error('Error applying diff:', e);
            break; // Stop applying subsequent diffs if one fails
        }
    }
    return content;
}

// 서버 시작
app.listen(PORT, '0.0.0.0', () => {
    console.log(`서버가 http://0.0.0.0:${PORT} 에서 실행 중입니다.`);
    ensureDir(PUBLIC_DIR);
    ensureDir(BACKUP_DIR);
});
