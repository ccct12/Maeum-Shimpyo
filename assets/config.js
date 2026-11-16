// 사이트 설정. 두 값만 채우면 실제 서비스로 동작합니다.
window.MAEUM_CONFIG = {
  // 카카오 디벨로퍼스 > 내 애플리케이션 > 앱 키 > JavaScript 키
  // (등록한 도메인에서만 동작하는 공개용 키라 여기에 적어도 됩니다)
  KAKAO_JS_KEY: '',

  // 구글 시트 Apps Script 웹 앱 주소 (배포 > 웹 앱 > .../exec)
  // 비워 두면 저장소의 data/facilities-fallback.json(공공데이터 좌표만)을 씁니다.
  DATA_URL: '',

  FALLBACK_URL: 'data/facilities-fallback.json',
  STATS_URL: 'data/stats.json',

  // 위치를 정하지 않았을 때 기준점
  DEFAULT_ORIGIN: { lat: 37.5663, lng: 126.9779, label: '서울시청' },
  LIST_STEP: 30
};
