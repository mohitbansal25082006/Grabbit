<script lang="ts">
  let { size = 34, animated = false }: { size?: number; animated?: boolean } = $props();
</script>

<span class="logo" class:animated style="--s:{size}px" aria-hidden="true">
  <svg viewBox="0 0 32 32">
    <path
      fill="currentColor"
      d="M11.2 2.4c1.9 0 2.9 3 2.9 6.6v3.2a9.6 9.6 0 0 0-5.7 0V9c0-3.6.9-6.6 2.8-6.6Zm9.6 0c1.9 0 2.8 3 2.8 6.6v3.2a9.6 9.6 0 0 0-5.7 0V9c0-3.6 1-6.6 2.9-6.6ZM16 11.4c5 0 9 3.9 9 8.8S21 29.6 16 29.6s-9-4.5-9-9.4 4-8.8 9-8.8Z"
    />
    <path
      fill="none"
      stroke="#FF5A2A"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      d="M16 16.2v7.2m-3.2-3.1 3.2 3.2 3.2-3.2"
    />
  </svg>
</span>

<style>
  .logo {
    width: var(--s);
    height: var(--s);
    border-radius: calc(var(--s) * 0.32);
    display: inline-grid;
    place-items: center;
    color: #fff;
    background:
      radial-gradient(120% 90% at 20% 10%, #ffb23d 0%, transparent 55%),
      conic-gradient(from 200deg at 60% 60%, #ff6b1a, #ff3d7f, #ff6b1a);
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.28),
      inset 0 -6px 12px -6px rgba(120, 0, 40, 0.5),
      0 8px 22px -10px rgba(255, 90, 42, 0.8);
    flex-shrink: 0;
  }
  svg {
    width: 64%;
    height: 64%;
    filter: drop-shadow(0 1px 1px rgba(90, 0, 30, 0.35));
  }
  .animated svg {
    animation: hop 1.6s cubic-bezier(0.3, 1.6, 0.5, 1) infinite;
    transform-origin: 50% 90%;
  }
</style>
