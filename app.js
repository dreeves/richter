document.addEventListener('DOMContentLoaded', () => {
    const hexagonContainer = document.getElementById('hexagon-container');

    // Create 100 draggable hexagons
    for (let i = 0; i < 100; i++) {
        const hex = document.createElement('div');
        hex.classList.add('hexagon');
        hex.setAttribute('draggable', 'false');
        hex.id = `hex-${i}`;

        hex.innerHTML = `
            <svg viewBox="0 0 100 100" width="20" height="20">
                <polygon points="50,0 93,25 93,75 50,100 7,75 7,25" fill="#000000"/>
            </svg>
        `;

        hex.style.position = 'relative';
        hex.addEventListener('mousedown', startDrag);
        hexagonContainer.appendChild(hex);
    }
});

function startDrag(e) {
    const hex = e.target;
    const rect = hex.getBoundingClientRect();
    
    // Prevent text selection while dragging
    document.body.style.userSelect = 'none';
    
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    
    hex.style.position = 'absolute';
    
    function moveHex(e) {
        hex.style.left = (e.clientX - offsetX) + 'px';
        hex.style.top = (e.clientY - offsetY) + 'px';
    }
    
    function stopDrag() {
        document.removeEventListener('mousemove', moveHex);
        document.removeEventListener('mouseup', stopDrag);
        // Re-enable text selection after dragging
        document.body.style.userSelect = '';
    }
    
    document.addEventListener('mousemove', moveHex);
    document.addEventListener('mouseup', stopDrag);
}
