import { useEffect, useState } from 'react';
import { Logo } from './Logo';

/** What the editor is "doing" while it starts. Shown in random order, a new one every ~1.3 s. */
const LINES = [
  'Подключаем мясной прокси',
  'Калибруем руки оператора',
  'Проверяем пульс оператора',
  'Пингуем кожаного: 1 мс… 2 мс… ушёл за кофе',
  'Объясняем ИИ, что кожаный тоже устаёт',
  'Согласовываем протокол «нажми F7»',
  'Смазываем суставы оператора',
  'Измеряем задержку между мозгом и пальцем',
  'Ищем кожаного у монитора',
  'Прокладываем провод от ИИ к ладони',
  'Заряжаем оператора кофе',
  'Проверяем, что кожаный не ушёл на обед',
  'Раскладываем чаты по полочкам',
  'Договариваемся с git push по-хорошему',
  'Убеждаем тесты, что они зелёные',
];

const shuffled = () => [...LINES].sort(() => Math.random() - 0.5);

/** Startup screen: the MPI logo comes alive (data runs along the wires) with joke status lines. */
export function Boot() {
  const [lines] = useState(shuffled);
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => x + 1), 1300);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="boot">
      <Logo size={150} animated className="boot-logo" />
      <div className="boot-shadow" aria-hidden="true" />
      <div key={i} className="boot-line">
        {lines[i % lines.length]}
        <span className="boot-dots">
          <span>.</span>
          <span>.</span>
          <span>.</span>
        </span>
      </div>
      <div className="boot-name">MPI · Meat Proxy Interface</div>
    </div>
  );
}
