import styles from './MarkerIcon.module.scss';

function MarkerIcon(count = 1) {
  if (count >= 2) {
    let size = 'small';
    if (count >= 10) size = 'extra-large';
    else if (count >= 7) size = 'large';
    else if (count >= 4) size = 'medium';

    return `
      <div class="${styles.cluster} ${styles[`cluster--${size}`]}" role="img" aria-label="건물 ${count}개">
        <span class="${styles.cluster__count}">${count}</span>
      </div>
    `;
  }

  return `
    <div class="${styles.wrapper}">
      <div class="${styles.icon}"></div>
      <div class="${styles.pluse}"></div>
    </div>
  `;
}

export default MarkerIcon;
