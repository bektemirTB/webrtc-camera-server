const CACHE_NAME = 'camera-app-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/camera.html',
  '/viewer.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Установка Service Worker и кэширование ресурсов
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Открыт кэш');
        return cache.addAll(urlsToCache);
      })
      .catch((error) => {
        console.log('Ошибка кэширования:', error);
      })
  );
  self.skipWaiting();
});

// Активация Service Worker и очистка старого кэша
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Удаление старого кэша:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  return self.clients.claim();
});

// Стратегия обработки запросов
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Не кэшируем WebRTC и WebSocket соединения
  if (url.protocol === 'wss:' || url.protocol === 'ws:') {
    return;
  }

  // Для навигационных запросов используем Network First
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Клонируем ответ для кэширования
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache);
          });
          return response;
        })
        .catch(() => {
          // Если сеть недоступна, возвращаем из кэша
          return caches.match(request);
        })
    );
    return;
  }

  // Для статических ресурсов используем Cache First
  event.respondWith(
    caches.match(request)
      .then((response) => {
        if (response) {
          return response;
        }

        return fetch(request)
          .then((response) => {
            // Проверяем валидность ответа
            if (!response || response.status !== 200 || response.type === 'error') {
              return response;
            }

            // Клонируем ответ для кэширования
            const responseToCache = response.clone();
            
            caches.open(CACHE_NAME)
              .then((cache) => {
                // Кэшируем только GET запросы
                if (request.method === 'GET') {
                  cache.put(request, responseToCache);
                }
              });

            return response;
          })
          .catch((error) => {
            console.log('Ошибка загрузки ресурса:', error);
            // Возвращаем базовую страницу из кэша при ошибке
            return caches.match('/index.html');
          });
      })
  );
});

// Обработка сообщений от клиента
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => caches.delete(cacheName))
        );
      })
    );
  }
});

// Фоновая синхронизация (опционально)
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-data') {
    event.waitUntil(syncData());
  }
});

async function syncData() {
  try {
    console.log('Выполнение фоновой синхронизации');
    // Здесь можно добавить логику синхронизации данных
  } catch (error) {
    console.error('Ошибка синхронизации:', error);
  }
}
