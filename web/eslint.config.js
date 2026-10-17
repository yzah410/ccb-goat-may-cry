import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'node_modules', 'public']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended, reactHooks.configs.flat.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: { 'react-refresh': reactRefresh },
    rules: {
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // 共享组件只许用主题 token，不许写死颜色（主题包目录除外）
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/\b(?:bg|text|border|ring|fill|stroke)-(?:red|blue|green|yellow|gray|slate|zinc|neutral|stone|white|black)-?\d*\b/]",
          message: '共享组件不要用 Tailwind 原生色板，请用主题 token（如 bg-surface-1 / text-fg-2）。',
        },
      ],
    },
  },
  {
    files: ['src/themes/**/*.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // 这些文件故意把组件和配套的 hook / 常量 / 命令式 API 放在一起（buttonVariants、toast()、confirm()、
    // useShellNav、主题 slots 对象……）。代价只是改它们时 Vite 热更新退化成整页刷新，不影响运行，所以不报。
    files: [
      'src/themes/**/*.tsx',
      'src/components/ui/{Badge,Button,Confirm,Toast}.tsx',
      'src/app/providers.tsx',
      'src/app/shell/{nav,parts}.tsx',
      'src/features/blocks/components/BlockList.tsx',
      'src/features/plans/components/PlanDialogs.tsx',
      'src/lib/emoji.tsx',
    ],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  {
    files: ['vite.config.ts', 'eslint.config.js', 'scripts/**/*'],
    languageOptions: { globals: globals.node },
  },
])
