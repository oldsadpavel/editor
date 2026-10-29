import { useEffect, useState } from 'react';

/** What the editor is "doing" while it starts. Shown in random order, a new one every ~1.3 s. */
const LINES = [
  'Будим Claude… он просил ещё пять минут',
  'Разглаживаем токены утюгом',
  'Пересчитываем лучи у звёздочки',
  'Уговариваем Fable не нервничать',
  'Ищем, куда делся кеш с диска C:',
  'Полируем вкладки до блеска',
  'Проверяем, не забыли ли закоммитить',
  'Кормим хомячков в серверной',
  'Раскладываем чаты по полочкам',
  'Договариваемся с git push по-хорошему',
  'Сдуваем пыль с CLAUDE.md',
  'Объясняем деплою, что всё будет хорошо',
  'Прогреваем кеш, чтобы не дуло',
  'Ставим запятые в правильные места',
  'Убеждаем тесты, что они зелёные',
];

const shuffled = () => [...LINES].sort(() => Math.random() - 0.5);

/** Startup screen: a spinning, bouncing Claude asterisk with joke status lines. */
export function Boot() {
  const [lines] = useState(shuffled);
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => x + 1), 1300);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="boot">
      <div className="boot-star" aria-hidden="true">
        ✳
      </div>
      <div className="boot-shadow" aria-hidden="true" />
      <div key={i} className="boot-line">
        {lines[i % lines.length]}
        <span className="boot-dots">
          <span>.</span>
          <span>.</span>
          <span>.</span>
        </span>
      </div>
      <div className="boot-name">Claude Editor</div>
    </div>
  );
}
