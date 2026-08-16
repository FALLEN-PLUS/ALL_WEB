/**
 * Embedded Hardware Studio · Fluid Aurora & 3D Interactive Workbench
 * 1. 柔和流体极光 Canvas 引擎 (Interactive Fluid Aurora Blobs)
 * 2. 3D 物理倾斜视差 (3D Perspective Tilt Parallax)
 * 3. 动态光流探照灯 (Mouse Spotlight & Dynamic Glow)
 * 4. 实时系统工程时钟 (Live System Clock)
 */

(function () {
    // =========================================================================
    // 1. 顶栏实时时钟
    // =========================================================================
    function initSystemClock() {
        const clockEl = document.getElementById('systemClock');
        if (!clockEl) return;

        function update() {
            const now = new Date();
            const h = String(now.getHours()).padStart(2, '0');
            const m = String(now.getMinutes()).padStart(2, '0');
            const s = String(now.getSeconds()).padStart(2, '0');
            clockEl.textContent = `${h}:${m}:${s} UTC+8`;
        }

        update();
        setInterval(update, 1000);
    }
    initSystemClock();

    // =========================================================================
    // 2. 柔和流体极光 Canvas 引擎
    // =========================================================================
    const canvas = document.getElementById('auroraCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    // 虚拟鼠标平滑追踪
    const mouse = {
        x: width / 2,
        y: height / 2,
        targetX: width / 2,
        targetY: height / 2,
        lerpSpeed: 0.04
    };

    // 4 团高级流体极光光斑
    const blobs = [
        {
            color: 'rgba(59, 130, 246, 0.18)', // 科技蓝
            baseX: width * 0.28,
            baseY: height * 0.35,
            radius: Math.min(width, height) * 0.38,
            speedX: 0.0006,
            speedY: 0.0008,
            phase: 0
        },
        {
            color: 'rgba(139, 92, 246, 0.15)', // 紫罗兰
            baseX: width * 0.72,
            baseY: height * 0.4,
            radius: Math.min(width, height) * 0.42,
            speedX: 0.0007,
            speedY: 0.0005,
            phase: Math.PI * 0.5
        },
        {
            color: 'rgba(6, 182, 212, 0.14)', // 翡翠青
            baseX: width * 0.45,
            baseY: height * 0.72,
            radius: Math.min(width, height) * 0.36,
            speedX: 0.0005,
            speedY: 0.0009,
            phase: Math.PI
        },
        {
            color: 'rgba(236, 72, 153, 0.12)', // 珊瑚粉
            baseX: width * 0.62,
            baseY: height * 0.25,
            radius: Math.min(width, height) * 0.32,
            speedX: 0.0008,
            speedY: 0.0006,
            phase: Math.PI * 1.5
        }
    ];

    window.addEventListener('resize', () => {
        width = canvas.width = window.innerWidth;
        height = canvas.height = window.innerHeight;
        blobs[0].baseX = width * 0.28; blobs[0].baseY = height * 0.35;
        blobs[1].baseX = width * 0.72; blobs[1].baseY = height * 0.4;
        blobs[2].baseX = width * 0.45; blobs[2].baseY = height * 0.72;
        blobs[3].baseX = width * 0.62; blobs[3].baseY = height * 0.25;
    });

    window.addEventListener('mousemove', (e) => {
        mouse.targetX = e.clientX;
        mouse.targetY = e.clientY;
    });

    // 极光渲染主循环 (60FPS 高斯漫射光斑)
    let time = 0;
    function renderAurora() {
        ctx.clearRect(0, 0, width, height);

        time += 1;

        // 鼠标惯性平滑
        mouse.x += (mouse.targetX - mouse.x) * mouse.lerpSpeed;
        mouse.y += (mouse.targetY - mouse.y) * mouse.lerpSpeed;

        const mouseOffsetX = (mouse.x - width / 2) * 0.12;
        const mouseOffsetY = (mouse.y - height / 2) * 0.12;

        for (let i = 0; i < blobs.length; i++) {
            const b = blobs[i];

            // 有机微漂移 + 鼠标柔和引力流
            const currentX = b.baseX + Math.sin(time * b.speedX + b.phase) * 60 + mouseOffsetX * (1 + i * 0.3);
            const currentY = b.baseY + Math.cos(time * b.speedY + b.phase) * 50 + mouseOffsetY * (1 + i * 0.3);
            const currentRadius = b.radius + Math.sin(time * 0.002 + b.phase) * 30;

            const gradient = ctx.createRadialGradient(
                currentX, currentY, 0,
                currentX, currentY, currentRadius
            );
            gradient.addColorStop(0, b.color);
            gradient.addColorStop(0.6, b.color.replace(/[\d\.]+\)$/, '0.04)'));
            gradient.addColorStop(1, 'transparent');

            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(currentX, currentY, currentRadius, 0, Math.PI * 2);
            ctx.fill();
        }

        requestAnimationFrame(renderAurora);
    }
    requestAnimationFrame(renderAurora);

    // =========================================================================
    // 3. 双旗舰工作台 3D 物理倾斜视差与动态光晕
    // =========================================================================
    function init3DWorkbenchCards() {
        const cards = document.querySelectorAll('.workbench-card');

        cards.forEach((card) => {
            let bounds;

            function rotateToMouse(e) {
                const mouseX = e.clientX;
                const mouseY = e.clientY;
                const leftX = mouseX - bounds.x;
                const topY = mouseY - bounds.y;
                const center = {
                    x: leftX - bounds.width / 2,
                    y: topY - bounds.height / 2
                };

                // 更新探照灯发光中心坐标
                card.style.setProperty('--mouse-x', `${leftX}px`);
                card.style.setProperty('--mouse-y', `${topY}px`);

                // 计算 3D 倾斜角度 (柔和物理倾角，最大 6.5 度)
                const rotateX = -(center.y / (bounds.height / 2)) * 6.5;
                const rotateY = (center.x / (bounds.width / 2)) * 6.5;

                card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.015, 1.015, 1.015)`;
            }

            card.addEventListener('mouseenter', () => {
                bounds = card.getBoundingClientRect();
                document.addEventListener('mousemove', rotateToMouse);
            });

            card.addEventListener('mouseleave', () => {
                document.removeEventListener('mousemove', rotateToMouse);
                card.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)';
            });

            // 点击整卡直接跳转
            card.addEventListener('click', (e) => {
                const targetHref = card.getAttribute('data-href');
                if (targetHref) {
                    window.location.href = targetHref;
                }
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init3DWorkbenchCards);
    } else {
        init3DWorkbenchCards();
    }
})();
