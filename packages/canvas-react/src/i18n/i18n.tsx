/**
 * Canvas UI localization.
 *
 * `<Canvas locale="ko" />` switches every built-in label — toolbars, menus,
 * empty states, tooltips — through one typed dictionary. The wire protocol and
 * artifact *content* are untouched: this is chrome-only.
 *
 * Design notes:
 * - Keys are English-ish identifiers; the `en` value doubles as the fallback,
 *   so a missing translation degrades to English instead of a raw key.
 * - The dictionary is a plain module object (tree-shakeable, no runtime i18n
 *   framework); adding a locale is adding one field per entry.
 */

import { createContext, useCallback, useContext, type ReactNode } from "react";

export type CanvasLocale = "en" | "ko";

type Entry = { en: string; ko: string };

const MESSAGES = {
  // --- shell / header ---
  undo: { en: "Undo", ko: "실행 취소" },
  redo: { en: "Redo", ko: "다시 실행" },
  export: { en: "Export ▾", ko: "내보내기 ▾" },
  openInTab: { en: "Open in new tab ↗", ko: "새 탭에서 열기 ↗" },
  copyHtml: { en: "Copy HTML", ko: "HTML 복사" },
  copied: { en: "Copied ✓", ko: "복사됨 ✓" },
  versionHistory: { en: "Version history", ko: "버전 기록" },
  prevVersion: { en: "Previous version", ko: "이전 버전" },
  nextVersion: { en: "Next version", ko: "다음 버전" },
  historyNote: {
    en: "read-only — select the latest version to edit",
    ko: "읽기 전용 — 편집하려면 최신 버전을 선택하세요",
  },
  loading: { en: "Loading…", ko: "불러오는 중…" },
  noRenderer: { en: "No renderer registered for type", ko: "등록된 렌더러가 없는 타입:" },
  writing: { en: "writing…", ko: "작성 중…" },
  open: { en: "open →", ko: "열기 →" },

  // --- artifact kinds (cards / tabs) ---
  kindWeb: { en: "Web page", ko: "웹 페이지" },
  kindDocument: { en: "Word document", ko: "문서" },
  kindChart: { en: "Chart", ko: "차트" },
  kindTable: { en: "Excel sheet", ko: "스프레드시트" },
  kindSlides: { en: "PowerPoint deck", ko: "프레젠테이션" },
  kindPdf: { en: "PDF", ko: "PDF" },

  // --- html (web) toolbar ---
  design: { en: "Design", ko: "디자인" },
  code: { en: "Code", ko: "코드" },
  add: { en: "ADD", ko: "추가" },
  heading: { en: "Heading", ko: "제목" },
  text: { en: "Text", ko: "텍스트" },
  button: { en: "Button", ko: "버튼" },
  image: { en: "Image", ko: "이미지" },
  divider: { en: "Divider", ko: "구분선" },
  pageMenu: { en: "Page…", ko: "페이지…" },
  sectionMenu: { en: "Section…", ko: "섹션…" },
  outlineMenu: { en: "Outline…", ko: "개요…" },
  layoutMenu: { en: "Layout…", ko: "레이아웃…" },
  themeMenu: { en: "Theme…", ko: "테마…" },
  fontMenu: { en: "Font…", ko: "글꼴…" },
  shapeMenu: { en: "Shape…", ko: "도형…" },
  a11yCheck: { en: "♿ Check", ko: "♿ 검사" },
  a11yTitle: { en: "Accessibility check", ko: "접근성 검사" },
  a11yClean: { en: "No issues found 🎉", ko: "문제가 없습니다 🎉" },
  bgImage: { en: "🖼 BG", ko: "🖼 배경" },
  present: { en: "Present", ko: "발표" },

  // --- document toolbar ---
  bold: { en: "Bold", ko: "굵게" },
  italic: { en: "Italic", ko: "기울임" },
  inlineCode: { en: "Code", ko: "코드" },
  bulletList: { en: "Bullet list", ko: "글머리 기호" },
  numberedList: { en: "Numbered list", ko: "번호 매기기" },
  quote: { en: "Quote", ko: "인용" },
  link: { en: "Link", ko: "링크" },
  words: { en: "words", ko: "단어" },
  minRead: { en: "min read", ko: "분 분량" },

  // --- table toolbar ---
  addColumn: { en: "＋ Column", ko: "＋ 열" },
  addRow: { en: "＋ Row", ko: "＋ 행" },
  sortBy: { en: "Sort…", ko: "정렬…" },
  filterRows: { en: "Filter…", ko: "필터…" },
  cleanStyling: { en: "Clean styling", ko: "스타일 정리" },
  freezeHeader: { en: "Freeze header", ko: "머리글 고정" },
  fillColor: { en: "Fill color", ko: "채우기 색" },
  textColor: { en: "Text color", ko: "글자 색" },
  alignLeft: { en: "Align left", ko: "왼쪽 정렬" },
  alignCenter: { en: "Align center", ko: "가운데 정렬" },
  alignRight: { en: "Align right", ko: "오른쪽 정렬" },
  numberFormat: { en: "Fmt…", ko: "서식…" },
  mergeCells: { en: "Merge", ko: "병합" },
  unmergeCells: { en: "Unmerge", ko: "병합 해제" },
  sheetHint: {
    en: "Right-click a header for more, or drag to edit",
    ko: "머리글 우클릭으로 더 보기 · 드래그로 편집",
  },

  // --- table extras ---
  quickFunction: { en: "Σ fx", ko: "Σ 함수" },
  quickFunctionTip: { en: "Quick function — writes the formula below the selection (right, for a single row)", ko: "빠른 함수 — 선택 영역 아래(한 행이면 오른쪽)에 수식 입력" },
  mergeTip: { en: "Merge the selected cells", ko: "선택한 셀 병합" },
  unmergeTip: { en: "Unmerge the selected cells", ko: "선택한 셀 병합 해제" },
  cleanStylingTip: { en: "Remove all cell fills and font colors", ko: "모든 셀 채우기·글자 색 제거" },
  freezeOnTip: { en: "Keep the header row visible while scrolling", ko: "스크롤 시 머리글 행 고정" },
  freezeOffTip: { en: "Unfreeze the header row", ko: "머리글 행 고정 해제" },
  numberFormatTip: { en: "Number format", ko: "숫자 서식" },
  sortByColumn: { en: "Sort by column", ko: "열 기준 정렬" },
  ascending: { en: "Ascending", ko: "오름차순" },
  descending: { en: "Descending", ko: "내림차순" },
  filterTip: { en: "Filter rows", ko: "행 필터" },
  fxPlaceholder: { en: "=formula or value", ko: "=수식 또는 값 입력" },
  fmtGeneral: { en: "General", ko: "일반" },
  fmtCurrency: { en: "Currency", ko: "통화" },
  fmtPercent: { en: "Percent", ko: "퍼센트" },
  fmtThousands: { en: "Thousands", ko: "천단위" },
  fmtDecimal: { en: "Decimal", ko: "소수" },
  fmtDate: { en: "Date", ko: "날짜" },

  // --- chart ---
  chartTitle: { en: "Chart title…", ko: "차트 제목…" },
  editData: { en: "Edit data", ko: "데이터 편집" },
  doneEditing: { en: "Done", ko: "완료" },
  addRowBtn: { en: "+ Add row", ko: "+ 행 추가" },
  downloadPng: { en: "⤓ PNG", ko: "⤓ PNG" },
  stacked: { en: "Stacked", ko: "누적" },
  seriesColor: { en: "Series color", ko: "계열 색" },
  seriesName: { en: "Series name", ko: "계열 이름" },
  removeRow: { en: "Remove row", ko: "행 삭제" },

  // --- slides (deck) ---
  addText: { en: "+ Text", ko: "+ 텍스트" },
  addImage: { en: "+ Image", ko: "+ 이미지" },
  addShape: { en: "+ Shape", ko: "+ 도형" },
  arrangeMenu: { en: "⤢ Arrange…", ko: "⤢ 정렬…" },
  padding: { en: "Pad", ko: "여백" },
  duplicate: { en: "Duplicate", ko: "복제" },
  delete: { en: "Delete", ko: "삭제" },
  group: { en: "Group", ko: "그룹" },
  ungroup: { en: "Ungroup", ko: "그룹 해제" },
  bringToFront: { en: "Bring to front", ko: "맨 앞으로" },
  sendToBack: { en: "Send to back", ko: "맨 뒤로" },
  fontSize: { en: "Font size", ko: "글자 크기" },
  resizeTip: { en: "Resize (hold Shift to lock aspect)", ko: "크기 조절 (Shift: 비율 고정)" },
  fitToggle: { en: "Fill / Fit", ko: "채우기 / 맞춤" },
  cornerRadius: { en: "Corner radius (px)", ko: "모서리 라운드 (px)" },
  rotateStep: { en: "Rotate 15° (Shift: −15°)", ko: "15° 회전 (Shift: −15°)" },
  rotationDeg: { en: "Rotation (degrees, clockwise)", ko: "회전 각도 (시계 방향)" },
  duplicateShort: { en: "Duplicate (⌘D)", ko: "복제 (⌘D)" },
  bringForward: { en: "Bring forward (⌘])", ko: "앞으로 (⌘])" },
  sendBackward: { en: "Send backward (⌘[)", ko: "뒤로 (⌘[)" },
  groupShort: { en: "Group (⌘G)", ko: "그룹 (⌘G)" },
  ungroupShort: { en: "Ungroup (⌘⇧G)", ko: "그룹 해제 (⌘⇧G)" },
  alignLeftEdges: { en: "Align left edges", ko: "왼쪽 가장자리 정렬" },
  alignHCenters: { en: "Align horizontal centers", ko: "가로 중앙 정렬" },
  alignRightEdges: { en: "Align right edges", ko: "오른쪽 가장자리 정렬" },
  alignTopEdges: { en: "Align top edges", ko: "위 가장자리 정렬" },
  alignVCenters: { en: "Align vertical centers", ko: "세로 중앙 정렬" },
  alignBottomEdges: { en: "Align bottom edges", ko: "아래 가장자리 정렬" },
  deleteSelection: { en: "Delete selection", ko: "선택 삭제" },
  presentHint: { en: "← → to navigate · Esc to exit", ko: "← → 이동 · Esc 종료" },
  speakerNotes: { en: "Speaker notes…", ko: "발표자 노트…" },

  // --- pdf ---
  download: { en: "⤓ Download", ko: "⤓ 다운로드" },
  openBtn: { en: "↗ Open", ko: "↗ 열기" },
  fitWidth: { en: "Fit", ko: "맞춤" },
  zoomIn: { en: "Zoom in", ko: "확대" },
  zoomOut: { en: "Zoom out", ko: "축소" },
  waitingPdf: { en: "Waiting for PDF…", ko: "PDF를 기다리는 중…" },

  // --- slides deck extras ---
  addTextBox: { en: "Add text box", ko: "텍스트 상자 추가" },
  addImageTip: { en: "Add image", ko: "이미지 추가" },
  addShapeTip: { en: "Add a shape", ko: "도형 추가" },
  applyLayout: { en: "Apply a layout", ko: "레이아웃 적용" },
  autoLayoutTip: { en: "Auto layout — align & distribute elements", ko: "자동 정렬 — 요소 정렬·배분" },
  bgColor: { en: "Background color", ko: "배경색" },
  bgImageTip: { en: "Background image", ko: "배경 이미지" },
  padTip: { en: "Content padding (% of slide)", ko: "콘텐츠 여백 (슬라이드 %)" },
  presentTip: { en: "Present (full screen)", ko: "발표 (전체 화면)" },
  duplicateSlide: { en: "Duplicate slide", ko: "슬라이드 복제" },
  deleteSlide: { en: "Delete slide", ko: "슬라이드 삭제" },
  theme: { en: "Theme", ko: "테마" },

  // --- devices ---
  desktop: { en: "Desktop", ko: "데스크톱" },
  tablet: { en: "Tablet", ko: "태블릿" },
  mobile: { en: "Mobile", ko: "모바일" },
  a11yIssues: { en: "accessibility issues", ko: "접근성 문제" },
  a11yNone: { en: "♿ No accessibility issues found", ko: "♿ 접근성 문제가 없습니다" },
  pageTemplateTitle: { en: "Start from a full page template (replaces the page)", ko: "전체 페이지 템플릿으로 시작 (기존 페이지 대체)" },
  sectionTemplateTitle: { en: "Insert a section template", ko: "섹션 템플릿 삽입" },
  jumpToHeading: { en: "Jump to a heading", ko: "제목으로 이동" },
  insertSlideLayout: { en: "Insert a slide layout", ko: "슬라이드 레이아웃 삽입" },
  applySlideTheme: { en: "Apply a slide theme", ko: "슬라이드 테마 적용" },
  insertShape: { en: "Insert a shape", ko: "도형 삽입" },
  slideFont: { en: "Slide font", ko: "슬라이드 글꼴" },
  slideBgImage: { en: "Slide background image", ko: "슬라이드 배경 이미지" },
  moveUp: { en: "Move up", ko: "위로" },
  moveDown: { en: "Move down", ko: "아래로" },

  // --- misc states ---
  waitingData: { en: "Waiting for data…", ko: "데이터를 기다리는 중…" },
  calculating: { en: "Calculating…", ko: "계산 중…" },
  loadingSheet: { en: "Loading spreadsheet…", ko: "스프레드시트 불러오는 중…" },
  dropToOpen: { en: "Drop to open", ko: "놓아서 열기" },
} satisfies Record<string, Entry>;

export type MessageKey = keyof typeof MESSAGES;

const LocaleContext = createContext<CanvasLocale>("en");

export interface CanvasLocaleProviderProps {
  locale?: CanvasLocale;
  children: ReactNode;
}

export function CanvasLocaleProvider({ locale = "en", children }: CanvasLocaleProviderProps) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): CanvasLocale {
  return useContext(LocaleContext);
}

/** `const t = useT(); t("sortBy")` → the label in the canvas's locale. */
export function useT(): (key: MessageKey) => string {
  const locale = useContext(LocaleContext);
  return useCallback((key: MessageKey) => MESSAGES[key][locale] ?? MESSAGES[key].en, [locale]);
}
