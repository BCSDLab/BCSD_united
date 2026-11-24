# Decision: 디자인 시스템의 기준은 코드다

Status: accepted
Scope: KOIN 웹·Android·iOS의 토큰, 공용 컴포넌트, 패턴
Decision: 디자인 시스템의 값과 컴포넌트는 각 플랫폼 저장소의 코드에서 정의한다. Figma의 기존 KOIN 디자인 시스템 파일은 기준으로 쓰지 않는다. Figma에는 코드에서 정한 값을 옮겨 담는다.
Rationale: 선행 디자인을 기다리는 시간을 없앤다. 값이 두 곳에 있으면 어느 쪽이 맞는지 매번 물어야 한다.
Evidence: https://github.com/BCSDLab/BCSD_united/issues/129
Exceptions: 없음
Bad example: Figma 파일의 색 이름과 값을 먼저 확정한 뒤 코드를 맞춘다.
Good example: 웹 토큰 파일에 값을 추가하고, 같은 변경에서 Figma 변수를 같은 값으로 맞춘다.
Open decisions: 웹 전역 토큰의 이름과 값(#130), Android·iOS 기준 위치
