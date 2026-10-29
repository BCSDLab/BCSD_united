import { loadCoopReview } from '~/services/coop/reviewStore';
import { reviewPageHandler } from '~/services/koin/reviewPage';

/** 생협 검토 페이지. */
export default reviewPageHandler({ label: '생협 검토 페이지', load: loadCoopReview });
