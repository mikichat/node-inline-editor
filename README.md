# Node.js Inline HTML Editor

웹 브라우저 상에서 서버에 있는 HTML 파일을 직접 확인하고 수정할 수 있는 **인라인 텍스트 에디터**입니다.
복잡한 설정 없이 HTML 파일의 텍스트 내용을 즉시 수정하고 저장할 수 있으며, 강력한 백업 및 복원 기능을 제공하여 안전한 편집 환경을 지원합니다.

## ✨ 주요 기능

- **📁 파일 목록 관리**: `public` 폴더 내의 HTML 파일 목록을 파일 크기, 수정 시간과 함께 한눈에 확인할 수 있습니다.
- **✏️ WYSIWYG 인라인 편집**: 별도의 에디터 창 없이 웹 페이지 내에서 텍스트를 클릭하여 바로 수정할 수 있습니다.
- **💾 자동 저장**: 포커스를 잃으면(Blur) 변경된 내용이 자동으로 서버에 저장됩니다.
- **🛡️ 안전한 편집**: `<html>`, `<body>`, `<ul>` 등 레이아웃을 해칠 수 있는 구조적 태그는 보호되고, 텍스트 내용만 안전하게 수정 가능합니다.
- **🎨 스타일 유지**: 텍스트를 수정하더라도 원본의 `<span>` 태그나 인라인 스타일(`color`, `font-size` 등)이 그대로 유지됩니다.
- **📦 자동 백업**: 파일이 수정될 때마다 `backup` 폴더에 타임스탬프와 함께 원본 파일이 자동으로 백업됩니다.
- **↩️ 되돌리기 (Undo)**: 편집 중 실수를 하더라도 [되돌리기] 버튼으로 직전 상태로 즉시 복구할 수 있습니다.
- **♻️ 복원 시스템**: 언제든지 과거의 특정 시점 백업 파일로 원본을 복원할 수 있습니다.

## 🛠️ 기술 스택

- **Runtime**: Node.js
- **Framework**: Express.js
- **Template Engine**: EJS
- **Session Store**: express-session (Undo 히스토리 관리)
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

### 3. 서버 실행
```bash
npm start
```

### 4. 접속
브라우저를 열고 다음 주소로 접속하세요.
[http://localhost:3000](http://localhost:3000)

## 📂 프로젝트 구조

```
├── backup/          # 자동 생성된 백업 파일 저장소
├── public/          # 편집 대상 HTML 파일 위치
├── views/           # EJS 템플릿 파일 (UI)
│   ├── list.ejs     # 파일 목록 페이지
│   └── editor.ejs   # 에디터 및 편집 로직
├── app.js           # 메인 서버 및 API 로직
└── package.json     # 프로젝트 설정 및 의존성
```