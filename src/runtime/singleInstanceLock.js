/**
 * Файловая блокировка единственного процесса бота. Нужна, чтобы не дублировать Long Poll, таймеры и запись SQLite.
 */
import {
    closeSync,
    mkdirSync,
    openSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';

/**
 * Защита от случайного запуска двух копий бота с одной базой данных.
 *
 * Почему это важно:
 * - два VK Long Poll процесса ответят на одно сообщение дважды;
 * - два Telegram getUpdates процесса будут спорить за один offset;
 * - фоновые задачи и случайные выкрики начнут дублироваться;
 * - SQLite получит лишнюю конкуренцию за запись.
 */
export function acquireSingleInstanceLock({
    lockPath = './data/vk-ai-bot.pid',
} = {}) {
    mkdirSync('./data', { recursive: true });

    const isProcessAlive = (pid) => {
        if (!Number.isInteger(pid) || pid <= 0) {
            return false;
        }

        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            // EPERM означает, что процесс существует, но текущему пользователю
            // запрещено посылать ему сигнал.
            return error?.code === 'EPERM';
        }
    };

    const removeOwnLock = () => {
        try {
            const storedPid = Number(readFileSync(lockPath, 'utf8').trim());

            if (storedPid === process.pid) {
                unlinkSync(lockPath);
            }
        } catch {
            // Файл уже удалён или принадлежит другому процессу.
        }
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const descriptor = openSync(lockPath, 'wx');

            try {
                writeFileSync(descriptor, String(process.pid), 'utf8');
            } finally {
                closeSync(descriptor);
            }

            process.once('exit', removeOwnLock);

            for (const signal of ['SIGINT', 'SIGTERM']) {
                process.once(signal, () => {
                    removeOwnLock();
                    process.exit(0);
                });
            }

            return;
        } catch (error) {
            if (error?.code !== 'EEXIST') {
                throw error;
            }

            let previousPid = 0;

            try {
                previousPid = Number(readFileSync(lockPath, 'utf8').trim());
            } catch {
                previousPid = 0;
            }

            if (previousPid !== process.pid && isProcessAlive(previousPid)) {
                throw new Error(
                    `Бот уже запущен: PID ${previousPid}. ` +
                    'Останови старый процесс или используй штатный перезапуск.',
                );
            }

            try {
                unlinkSync(lockPath);
            } catch (unlinkError) {
                if (unlinkError?.code !== 'ENOENT') {
                    throw unlinkError;
                }
            }
        }
    }

    throw new Error('Не удалось создать блокировку единственного экземпляра бота.');
}
