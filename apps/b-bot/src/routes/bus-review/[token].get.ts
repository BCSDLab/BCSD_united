import { loadBusReview } from '~/services/bus/reviewStore';
import { reviewPageHandler } from '~/services/koin/reviewPage';

/** 버스 검토 페이지. 슬랙 메시지의 링크로 바로 열린다. */
export default reviewPageHandler({ label: '버스 검토 페이지', load: loadBusReview });
