/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Cairo', 'Noto Sans Arabic', 'Segoe UI', 'Tahoma', 'sans-serif'],
      },
      colors: {
        brand: {
          50: '#eef8ff',
          100: '#d9efff',
          200: '#bce3ff',
          300: '#8ed2ff',
          400: '#59b7ff',
          500: '#3198f5',
          600: '#1779da',
          700: '#1460b0',
          800: '#164f8b',
          900: '#174373',
          950: '#0f294b'
        },
      },
      boxShadow: {
        panel: '0 18px 55px -28px rgba(15, 41, 75, 0.35)',
      },
    },
  },
  plugins: [],
};
