/**
 * Description: Local Tailwind build configuration for the offline Electron interface.
 * Version: 2.3.6
 * Author: Novozhilov Artem
 */

module.exports = {
  content: ['./asm_generator_form_v9.html'],
  theme: {
    extend: {
      fontFamily: {
        display: ['Inter', 'sans-serif'],
        body: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace']
      }
    }
  },
  plugins: []
};
