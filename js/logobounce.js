// logobounce.js
document.addEventListener('DOMContentLoaded', () => {
  const logo = document.querySelector('.logo');

  logo.addEventListener('mouseenter', () => {
    // Remove the class if it exists, to retrigger animation
    logo.classList.remove('bounce');

    // Trigger reflow so animation can restart
    void logo.offsetWidth;

    // Add class to start bounce animation
    logo.classList.add('bounce');
  });
});
