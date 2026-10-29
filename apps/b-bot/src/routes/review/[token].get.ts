import { loadReview } from '~/services/lecture/reviewStore';
import { reviewPageHandler } from '~/services/koin/reviewPage';

/** 강의 검토 페이지. 슬랙 메시지의 링크로 바로 열린다. */
export default reviewPageHandler({ label: '검토 페이지', load: loadReview });
