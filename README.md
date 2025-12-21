# Node.js Inline HTML Editor

웹 브라우저 상에서 서버에 있는 HTML 파일을 직접 확인하고 수정할 수 있는 **인라인 텍스트 에디터**입니다.
복잡한 설정 없이 HTML 파일의 텍스트 내용을 즉시 수정하고 저장할 수 있으며, 강력한 백업 및 복원 기능을 제공하여 안전한 편집 환경을 지원합니다.

## ✨ 주요 기능

- **🔐 보안 시스템**:
    - **세션 기반 인증**: 관리자 비밀번호를 통해 허가된 사용자만 접근 가능합니다.
    - **자동 로그아웃**: 10분간 입력이나 움직임이 없을 경우 보안을 위해 자동으로 로그아웃됩니다.
- **📁 유연한 디렉토리 설정**: `PUBLIC_DIR` 환경 변수를 통해 편집할 HTML 파일이 위치한 디렉토리를 자유롭게 지정할 수 있습니다.
- **✏️ WYSIWYG 인라인 편집**: 별도의 에디터 창 없이 웹 페이지 내에서 텍스트를 클릭하여 바로 수정할 수 있습니다.
- **🎯 스마트 편집 모드**:
    - **싱글클릭**: 단순 텍스트 인라인 편집 (한 줄 태그)
    - **더블클릭**: 멀티라인 편집 팝업 (여러 줄 태그)
    - **자동 감지**: `<li>`, `<td>` 태그의 단순 텍스트는 인라인 편집 가능
- **🔗 개체 속성 편집**: 이미지(`<img>`) 태그의 경로(`src`)와 링크(`<a>`) 태그의 주소(`href`)를 클릭 한 번으로 간편하게 수정할 수 있습니다.
- **⌨️ 편의성 강화 (단축키)**:
    - `Ctrl + S`: 현재 편집 중인 내용 즉시 저장
    - `Ctrl + Z`: 직전 편집 상태로 되돌리기 (Undo)
    - `Ctrl + B`: 소스 편집기에서 코드 자동 정렬 (Beautify)
- **📝 소스 편집 모드**: 전체 HTML 소스코드를 직접 편집할 수 있는 모달 에디터를 제공합니다.
- **🔧 소스 정렬 (Beautify)**: 소스 편집 모달에서 원클릭으로 HTML 코드를 자동 정렬하여 가독성을 높입니다.
- **🛡️ 스마트 태그 보존**:
    - `<html>`, `<body>`, `<div>`, `<span>` 등 구조적/컨테이너 태그는 자동으로 제외됩니다.
    - 텍스트 내의 `<span>`, `<strong>` 등 인라인 스타일 태그는 그대로 유지됩니다.
    - 저장 시 에디터용 속성(`data-line`, `contenteditable`)은 자동으로 제거되어 원본 코드를 오염시키지 않습니다.
- **💾 자동 저장**: 포커스를 잃으면(Blur) 변경된 내용이 자동으로 서버에 저장됩니다.
- **📦 스마트 백업 시스템**: 
    - **일별 스냅샷**: 하루의 첫 수정과 마지막 수정은 전체 파일로 저장됩니다.
    - **효율적인 Diff 저장**: 중간 수정 사항은 변경된 부분(Diff)만 저장하여 공간을 절약합니다.
    - **경로 기반 관리**: 파일 경로(`a/b/test.html`)를 기반으로 백업 폴더(`a__b__test`)를 자동 생성하여 중복을 방지합니다.
- **♻️ 복원 시스템**: 언제든지 과거의 특정 시점 백업 파일로 원본을 복원할 수 있습니다.

## 🛠️ 기술 스택

- **Runtime**: Node.js
- **Framework**: Express.js
- **Security**: Helmet (HTTP 헤더 보호), express-rate-limit (요청 제한)
- **Template Engine**: EJS
- **Session Store**: express-session (인증 및 Undo 히스토리 관리)
- **Formatting**: js-beautify (HTML 코드 자동 정리)
- **Styling**: Vanilla CSS (Glassmorphism Design)

## 🚀 설치 및 실행

### 1. 저장소 클론
```bash
git clone https://github.com/mikichat/node-inline-editor.git
cd node-inline-editor
```

### 2. 의존성 설치
```bash
npm install
```

### 3. 환경 변수 설정
`.env` 파일을 생성하거나 `.env.example`을 복사하여 다음 항목을 설정하세요.
```env
PORT=3000
ADMIN_PASSWORD=your_password  # 관리자 비밀번호
SESSION_SECRET=your_secret    # 세션 비밀키
PUBLIC_DIR=./public           # 편집 대상 디렉토리
```

### 4. 서버 실행
```bash
npm start
```

### 5. 접속
브라우저를 열고 다음 주소로 접속하세요.
[http://localhost:3000](http://localhost:3000)

## 📂 프로젝트 구조

```
├── backup/          # 자동 생성된 백업 파일 저장소
├── public/          # 편집 대상 HTML 파일 위치 (기본값)
├── views/           # EJS 템플릿 파일 (UI)
│   ├── login.ejs    # 로그인 페이지
│   ├── list.ejs     # 파일 목록 페이지
│   └── editor.ejs   # 에디터 및 편집 로직
├── app.js           # 메인 서버 및 API 로직
└── package.json     # 프로젝트 설정 및 의존성
```