import type { DepartmentContactDepartment } from 'api/departmentContact/entity';
import ClipboardCopyIcon from 'assets/svg/department/clipboard-copy-icon.svg';
import useLogger from 'utils/hooks/analytics/useLogger';
import { copyToClipboard } from 'utils/ts/copyToClipboard';
import showToast from 'utils/ts/showToast';

import styles from './DepartmentCard.module.scss';

// 같은 카드가 분류 화면의 검색 결과와 분류별 부서 목록에 함께 쓰여, 화면에 따라 로그 label이 다르다
const PHONE_COPY_EVENT_LABEL = {
  department_main: 'department__department_main__contact__phone_copy__click',
  department_list: 'department__department_list__contact__phone_copy__click',
} as const;

interface DepartmentCardProps {
  department: DepartmentContactDepartment;
  /** 카드가 보이는 화면. 분류 화면의 검색 결과는 `department_main`, 분류별 부서 목록은 `department_list`다 */
  screen: keyof typeof PHONE_COPY_EVENT_LABEL;
  className?: string;
}

export default function DepartmentCard({ department, screen, className }: DepartmentCardProps) {
  const logger = useLogger();

  const copyPhoneNumber = async (phoneNumber: string) => {
    await copyToClipboard(phoneNumber);
    showToast('info', '전화번호가 복사되었습니다.');
    logger.actionEventClick({
      event_name: 'DA2',
      event_label: PHONE_COPY_EVENT_LABEL[screen],
      value: '전화번호 복사',
    });
  };

  if (!department.is_single_contact) {
    return (
      <div className={`${styles.card} ${className ?? ''}`}>
        <h2 className={styles.card__title}>{department.name}</h2>
        <div className={styles.table}>
          <div className={`${styles.table__row} ${styles['table__row--head']}`}>
            <span className={styles.table__task}>업무</span>
            <span className={styles.table__phone}>전화번호</span>
          </div>
          {department.contacts.map((contact) => (
            <div key={`${contact.task}-${contact.phone_number}`} className={styles.table__row}>
              <span className={styles.table__task}>{contact.task}</span>
              <button
                type="button"
                className={styles.table__phone}
                aria-label={`${contact.phone_number} 복사`}
                onClick={() => copyPhoneNumber(contact.phone_number)}
              >
                {contact.phone_number}
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const [contact] = department.contacts;

  return (
    <div className={`${styles.card} ${className ?? ''}`}>
      <h2 className={styles.card__title}>{department.name}</h2>
      <div className={styles.single}>
        <span className={styles.single__phone}>전화번호 : {contact?.phone_number}</span>
        {contact && (
          <button type="button" className={styles.single__copy} onClick={() => copyPhoneNumber(contact.phone_number)}>
            전화번호 복사
            <ClipboardCopyIcon aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
