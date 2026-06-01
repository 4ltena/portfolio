document.addEventListener('DOMContentLoaded', () => {
    const timeElem = document.querySelector('.post-date');
    if (!timeElem) return;

    const now = new Date();

    const formattedDate = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
    const isoDate = now.toISOString().split('T')[0];

    timeElem.textContent = formattedDate;
    timeElem.setAttribute('datetime', isoDate);
});
