# Experience transfer between agents, a head office phone

A real task on real sites. Find the public phone of a company's head office on its own website. Agent A explores strategies on a training set, the ones that turn failures into right answers become recipes in a Xonta orchestrator (0.19), and a separate agent B asks the live orchestrator for a recipe on a holdout set. The orchestrator picks the arm, every task runs with and without the recipe, and only answers that match the phone the company itself reports to the SEC (EDGAR) count.

- `agent-v4.mjs` the agent, GigaChat picks only from numbers found on the page. It respects robots.txt and doesn't get around bot protection.
- `ground-truth.mjs` ground truth from SEC EDGAR and a fixed split, `companies-us.json` the list.
- `run.mjs` setup, explore, transfer, report.

The strategy menu was written by people. The orchestrator doesn't invent strategies, it checks which ones help and hands them on.

---

Передача опыта между агентами на настоящей задаче: найти публичный телефон головного офиса на сайте компании. Агент A пробует стратегии на обучающей части, те, что превращают неудачу в верный ответ, становятся рецептами в оркестраторе Xonta (0.19). Отдельный агент B на проверочной части сам просит рецепт у живого оркестратора. Группу назначает оркестратор, каждая задача идёт с рецептом и без, засчитывается только номер, совпавший с тем, что компания указывает в отчётности SEC (EDGAR). Меню стратегий составили люди, оркестратор проверяет, какие помогают, и передаёт их дальше.
