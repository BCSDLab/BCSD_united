import { lazy, Suspense, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';

import type { Semester } from 'api/timetable/entity';
import ROUTES from 'static/routes';
import useMediaQuery from 'utils/hooks/layout/useMediaQuery';

import DefaultPage from './DefaultPage';
import styles from './ModifyTimetablePage.module.scss';

const MobilePage = lazy(
  () => import('components/TimetablePage/MainTimetablePage/MobilePage').then((mod) => ({ default: mod.MobilePage })),
);

export default function ModifyTimetablePage({ id, semester }: { id?: string; semester: Semester }) {
  const isMobile = useMediaQuery();
  const timetableFrameId = id ? Number(id) : null;
  const navigate = useNavigate();

  useEffect(() => {
    if (timetableFrameId === null) {
      navigate({ href: ROUTES.Timetable() });
    }
  }, [timetableFrameId, navigate]);

  if (timetableFrameId === null) {
    return null;
  }

  return (
    <div className={styles.page}>
      {!isMobile ? (
        <DefaultPage timetableFrameId={timetableFrameId} semester={semester} />
      ) : (
        <Suspense fallback={null}>
          <MobilePage timetableFrameId={timetableFrameId} />
        </Suspense>
      )}
    </div>
  );
}
